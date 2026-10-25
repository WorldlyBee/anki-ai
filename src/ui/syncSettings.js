import qrcode from 'qrcode-generator';
import { enableSync, disableSync, syncNow, getSyncConfig, getSyncStatus, onSyncStatus, pairingLink } from '../sync/sync.js';
import { h, toast, dialog } from './dom.js';
import { onLeave } from '../router.js';

export function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

export function syncStatusText(st) {
  if (st.state === 'off') return 'Sync is off';
  if (st.state === 'syncing') return 'Syncing…';
  if (st.state === 'offline') return 'Offline. Will sync when back online';
  if (st.state === 'error') return `Sync problem: ${st.error}`;
  return `Synced ${timeAgo(st.lastSync)}`;
}

/** The "Sync between devices" block on the settings screen. */
export async function syncSection(rerender) {
  const config = await getSyncConfig();
  const box = h('div');

  if (!config) {
    const repoIn = h('input', { type: 'text', placeholder: 'your-username/anki-ai-data', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    const tokenIn = h('input', { type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' });
    const btn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!repoIn.value.trim() || !tokenIn.value.trim()) return toast('Fill in both the repo and the token');
        btn.disabled = true;
        btn.textContent = 'Connecting…';
        try {
          const res = await enableSync({ token: tokenIn.value.trim(), repo: repoIn.value.trim() }, (m) => toast(m, 20000));
          toast(res.pulled ? 'Sync is on. Pulled in your cards from your other device.' : 'Sync is on. Your cards are backed up to GitHub.', 4000);
          rerender();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = 'Turn on sync';
          await dialog({ title: "Couldn't turn on sync", body: h('p', {}, err.message || String(err)) });
        }
      },
    }, 'Turn on sync');
    box.append(
      h('p', { class: 'note' }, 'Study on your phone and your laptop and keep them in step. Your cards sync through a private GitHub repo that only you can see. Free, no new account.'),
      h('p', { class: 'note' }, h('b', {}, 'Already set up on another device? '), "Open Settings there, tap \"Link another device\", and scan the code with this device's camera."),
      h('details', { class: 'setup' },
        h('summary', {}, 'First-time setup (about 3 minutes)'),
        h('ol', { class: 'note' },
          h('li', {}, 'Create a ', h('b', {}, 'private'), ' repo called ', h('code', {}, 'anki-ai-data'), ': ',
            h('a', { href: 'https://github.com/new?name=anki-ai-data&visibility=private', target: '_blank', rel: 'noopener' }, 'github.com/new')),
          h('li', {}, 'Create a token: ',
            h('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener' }, 'new fine-grained token'),
            '. Name it "Aristotle" and set the expiration to a year or longer. Under ', h('b', {}, 'Repository access'), ' pick ', h('b', {}, 'Only select repositories'),
            ' → anki-ai-data. Under ', h('b', {}, 'Permissions'), ', set ', h('b', {}, 'Contents'), ' to ', h('b', {}, 'Read and write'), '. Generate it and copy it.'),
          h('li', {}, 'Paste both here:'),
        ),
        h('label', { class: 'field' }, h('span', {}, 'Repo'), repoIn),
        h('label', { class: 'field' }, h('span', {}, 'Token'), tokenIn, h('small', {}, 'Stored only on this device. Only works on that one repo.')),
        h('div', { class: 'row-btns' }, btn),
      ),
    );
    return box;
  }

  const statusLine = h('p', { class: 'note sync-status' }, syncStatusText(getSyncStatus()));
  const off = onSyncStatus((st) => (statusLine.textContent = syncStatusText(st)));
  onLeave(off);
  box.append(
    h('p', { class: 'note' }, 'Syncing with ', h('code', {}, config.repo), '.'),
    statusLine,
    h('div', { class: 'row-btns' },
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          try {
            const r = await syncNow({ onProgress: (m) => toast(m, 20000) });
            toast(r.pulled || r.pushed ? `Synced: ${r.pushed} change${r.pushed === 1 ? '' : 's'} up, ${r.pulled} batch${r.pulled === 1 ? '' : 'es'} down` : 'Already up to date');
          } catch (err) {
            toast(err.message, 5000);
          }
        },
      }, 'Sync now'),
      h('button', { class: 'btn', onclick: () => showPairing(config) }, 'Link another device'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          const ok = await dialog({
            title: 'Turn off sync on this device?',
            body: h('p', {}, 'Your cards stay on this device and in your GitHub repo. This device just stops syncing.'),
            buttons: [{ label: 'Cancel', value: false }, { label: 'Turn off', value: true, danger: true }],
          });
          if (ok) {
            await disableSync();
            rerender();
          }
        },
      }, 'Turn off'),
    ),
  );
  return box;
}

function showPairing(config) {
  const link = pairingLink(config);
  const qr = qrcode(0, 'L');
  qr.addData(link);
  qr.make();
  dialog({
    title: 'Link another device',
    body: h('div', {},
      h('p', { class: 'note' }, "Scan this with the other device's camera, or send yourself the link. It opens the app with sync already set up."),
      h('div', { class: 'qr', html: qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }) }),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: () => navigator.clipboard?.writeText(link).then(() => toast('Link copied')) }, 'Copy link'),
        navigator.share && h('button', { class: 'btn', onclick: () => navigator.share({ title: 'Aristotle sync link', url: link }).catch(() => {}) }, 'Share…'),
      ),
      h('p', { class: 'note' }, 'The link contains your sync token. Only send it to yourself.'),
    ),
    buttons: [{ label: 'Done', value: true, primary: true }],
  });
}
