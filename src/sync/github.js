// Minimal GitHub client for using a private repo as sync storage (Git Data API).

const API = 'https://api.github.com';

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class GitHubRepo {
  constructor({ token, repo }) {
    this.token = token;
    this.repo = repo.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    this.branch = null;
  }

  req(path, opts) {
    return this.api(`/repos/${this.repo}${path}`, opts);
  }

  async api(path, { method = 'GET', body, raw = false } = {}) {
    const res = await fetch(`${API}${path}`, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        msg = (await res.json()).message || msg;
      } catch {}
      throw new GitHubError(res.status, msg);
    }
    if (raw) return new Uint8Array(await res.arrayBuffer());
    return res.status === 204 ? null : res.json();
  }

  /** Checks access and makes sure the repo has a first commit (the Git Data API needs one). */
  async init() {
    let info;
    try {
      info = await this.req('');
    } catch (err) {
      if (err.status === 404) throw new GitHubError(404, await this.explainNotFound());
      if (err.status === 401) throw new GitHubError(401, 'GitHub rejected the token. It may be mistyped or expired.');
      throw err;
    }
    if (!info.private) throw new GitHubError(400, `"${this.repo}" is public. Use a private repo so your study data stays private.`);
    if (info.permissions && !info.permissions.push) throw new GitHubError(403, 'Your token can read this repo but not write to it. Give it "Contents: Read and write".');
    this.branch = info.default_branch || 'main';
    try {
      await this.head();
    } catch (err) {
      if (err.status !== 409 && err.status !== 404) throw err;
      // Brand-new empty repo
      await this.req('/contents/README.md', {
        method: 'PUT',
        body: { message: 'Set up Aristotle sync', content: btoa('Sync data for Aristotle. Managed by the app; please don\'t edit by hand.\n') },
      });
    }
  }

  /** GitHub says 404 both for "doesn't exist" and "token can't see it", so work out which. */
  async explainNotFound() {
    let login = null;
    let visible = [];
    try {
      login = (await this.api('/user')).login;
      visible = (await this.api('/user/repos?per_page=100&sort=updated')).filter((r) => r.private).map((r) => r.full_name);
    } catch {}
    const wanted = this.repo.toLowerCase();
    const name = wanted.split('/').pop();
    const fix = 'On GitHub, open Settings → Developer settings → Fine-grained tokens → your token → Edit. Under "Repository access" choose "Only select repositories", add the repo, and save. (Also check "Contents" is "Read and write" under Permissions.)';
    if (login && !wanted.startsWith(login.toLowerCase() + '/')) {
      return `The token belongs to "${login}", but the repo is under "${this.repo.split('/')[0]}". Use "${login}/${name}" if that's where you made it.`;
    }
    const near = visible.find((r) => r.toLowerCase() !== wanted && r.toLowerCase().includes(name.replace(/-/g, '')) );
    if (near) return `Your token can't see "${this.repo}", but it can see "${near}". Did you mean that one?`;
    if (!visible.length) {
      return `Your token works${login ? ` (signed in as ${login})` : ''}, but it hasn't been given access to "${this.repo}", or that repo doesn't exist yet. ${fix}`;
    }
    return `Your token can only see: ${visible.slice(0, 5).join(', ')}. It hasn't been given access to "${this.repo}" (or that repo doesn't exist). ${fix}`;
  }

  async head() {
    const ref = await this.req(`/git/ref/heads/${this.branch}`);
    return ref.object.sha;
  }

  /** All files in the repo at a commit, as Map(path → blob sha). */
  async files(commitSha) {
    const commit = await this.req(`/git/commits/${commitSha}`);
    const tree = await this.req(`/git/trees/${commit.tree.sha}?recursive=1`);
    const out = new Map();
    for (const e of tree.tree) if (e.type === 'blob') out.set(e.path, e.sha);
    return { files: out, treeSha: commit.tree.sha };
  }

  readBlob(sha) {
    return this.req(`/git/blobs/${sha}`, { raw: true });
  }

  async writeBlob(bytes) {
    const res = await this.req('/git/blobs', { method: 'POST', body: { content: toBase64(bytes), encoding: 'base64' } });
    return res.sha;
  }

  /**
   * Commits files on top of the current branch head. `changes` is [{ path, sha }] (sha null deletes).
   * Retries if another device pushed in between; our paths never overlap, so no merge is needed.
   */
  async commit(changes, message) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const parent = await this.head();
      const { tree: base } = await this.req(`/git/commits/${parent}`);
      const tree = await this.req('/git/trees', {
        method: 'POST',
        body: { base_tree: base.sha, tree: changes.map((c) => ({ path: c.path, mode: '100644', type: 'blob', sha: c.sha })) },
      });
      const commit = await this.req('/git/commits', { method: 'POST', body: { message, tree: tree.sha, parents: [parent] } });
      try {
        await this.req(`/git/refs/heads/${this.branch}`, { method: 'PATCH', body: { sha: commit.sha, force: false } });
        return commit.sha;
      } catch (err) {
        if (err.status !== 422 && err.status !== 409) throw err;
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
    throw new GitHubError(409, 'Another device kept syncing at the same time. Try again in a moment.');
  }
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
