import { ZipWriter, ZipReader, Uint8ArrayWriter, Uint8ArrayReader, BlobReader, BlobWriter } from '@zip.js/zip.js';
import { db, getKV, setKV, SYNCED_TABLES, onLocalChange, markAllDirty } from '../db.js';
import { GitHubRepo } from './github.js';
import { mimeFor } from '../import/apkg.js';
import { collectBackupData, restoreData } from '../backup.js';

// Repo layout:
//   journal/<device>/<time>.json.gz   changes uploaded by one device in one sync
//   snapshot/<time>.json.gz           everything, written now and then so old journals can be removed
//   media/<device>-<time>-<n>.zip     images and audio, bundled so uploads stay few
//   backups/<time>.json.gz            dated snapshots you can roll back to (images live in media/)
const BACKUPS_KEPT = 12;
const BACKUP_EVERY = 7 * 86_400_000;
const PACK_LIMIT = 20 * 1024 * 1024;
// Journal files allowed before they're folded into a snapshot (tests lower it via localStorage)
const compactAfter = () => Number(globalThis.localStorage?.getItem('anki-ai-compact-after')) || 150;

let running = null;
let again = false;
let timer = null;
const statusListeners = new Set();
let status = { state: 'off' };

export const getSyncStatus = () => status;
export function onSyncStatus(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
function setStatus(patch) {
  status = { ...status, ...patch };
  statusListeners.forEach((fn) => fn(status));
}

export async function getSyncConfig() {
  return getKV('syncConfig', null);
}

/** Validates the repo/token, saves them and runs a first sync. */
export async function enableSync({ token, repo }, onProgress) {
  const gh = new GitHubRepo({ token, repo });
  await gh.init();
  const deviceId = (await getKV('deviceId')) || newDeviceId();
  await setKV('deviceId', deviceId);
  await setKV('syncConfig', { token, repo: gh.repo });
  await setKV('syncState', { applied: [], mediaIndex: {} });
  await markAllDirty();
  return syncNow({ onProgress });
}

export async function disableSync() {
  clearTimeout(timer);
  await db.kv.bulkDelete(['syncConfig', 'syncState']);
  setStatus({ state: 'off', error: null });
}

export function pairingLink(config) {
  const payload = btoa(JSON.stringify({ t: config.token, r: config.repo })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${location.origin}${location.pathname}#/pair/${payload}`;
}
export function parsePairing(payload) {
  const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  const { t, r } = JSON.parse(json);
  return { token: t, repo: r };
}

/** Runs a sync (or joins the one already running). Resolves with { pulled, pushed }. */
export function syncNow(opts = {}) {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      return await runSync(opts);
    } finally {
      running = null;
      if (again) {
        again = false;
        scheduleSync(1000);
      }
    }
  })();
  return running;
}

export function scheduleSync(delay = 30_000) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow().catch(() => {}), delay);
}

/** Sync on start, shortly after changes, when the app is hidden and when it comes back. */
export async function startAutoSync() {
  const config = await getSyncConfig();
  const state = await getKV('syncState', {});
  setStatus({ state: config ? 'idle' : 'off', lastSync: state.lastSync || null });
  onLocalChange(async () => {
    if (await getSyncConfig()) scheduleSync();
  });
  document.addEventListener('visibilitychange', async () => {
    if (!(await getSyncConfig())) return;
    if (document.visibilityState === 'hidden') syncNow().catch(() => {});
    else if (!status.lastSync || Date.now() - status.lastSync > 60_000) syncNow().catch(() => {});
  });
  window.addEventListener('online', () => getSyncConfig().then((c) => c && syncNow().catch(() => {})));
  if (config) syncNow().catch(() => {});
}

// ---------------------------------------------------------------------------

async function runSync({ onProgress = () => {} } = {}) {
  const config = await getSyncConfig();
  if (!config) return { pulled: 0, pushed: 0 };
  if (!navigator.onLine) {
    setStatus({ state: 'offline' });
    return { pulled: 0, pushed: 0 };
  }
  setStatus({ state: 'syncing', error: null });
  try {
    const gh = new GitHubRepo(config);
    await gh.init();
    const deviceId = await getKV('deviceId');
    const state = await getKV('syncState', { applied: [], mediaIndex: {} });
    const applied = new Set(state.applied);
    const mediaIndex = state.mediaIndex || {};
    const save = () => setKV('syncState', { ...state, applied: [...applied], mediaIndex });

    // ---- pull ----
    onProgress('Checking for changes…');
    const { files } = await gh.files(await gh.head());
    const paths = [...files.keys()];
    const journals = paths.filter((p) => p.startsWith('journal/')).sort(byTimestamp);
    const snapshots = paths.filter((p) => p.startsWith('snapshot/')).sort(byTimestamp);
    let pulled = 0;

    const latestSnap = snapshots.at(-1);
    if (latestSnap && !applied.has(latestSnap)) {
      onProgress('Downloading your collection…');
      const snap = await gunzipJson(await gh.readBlob(files.get(latestSnap)));
      if (snap.covers.some((p) => !applied.has(p))) {
        await applyRemote(snap);
        pulled++;
      }
      Object.assign(mediaIndex, snap.media);
      snap.covers.forEach((p) => applied.add(p));
      applied.add(latestSnap);
      await save();
    }
    const pending = journals.filter((p) => !applied.has(p));
    for (const [i, p] of pending.entries()) {
      if (!p.startsWith(`journal/${deviceId}/`)) {
        onProgress(`Downloading changes… ${i + 1}/${pending.length}`);
        const j = await gunzipJson(await gh.readBlob(files.get(p)));
        await applyRemote(j);
        Object.assign(mediaIndex, j.media);
        pulled++;
      }
      applied.add(p);
      if (i % 10 === 9) await save();
    }
    await save();

    // Images other devices added
    const have = new Set(await db.media.toCollection().primaryKeys());
    const missing = Object.entries(mediaIndex).filter(([name, pack]) => !have.has(name) && files.has(pack));
    const byPack = new Map();
    for (const [name, pack] of missing) (byPack.get(pack) || byPack.set(pack, new Set()).get(pack)).add(name);
    let packNo = 0;
    for (const [pack, names] of byPack) {
      onProgress(`Downloading images… ${++packNo}/${byPack.size}`);
      const zip = new ZipReader(new Uint8ArrayReader(await gh.readBlob(files.get(pack))));
      for (const entry of await zip.getEntries()) {
        if (!names.has(entry.filename)) continue;
        const blob = await entry.getData(new BlobWriter(mimeFor(entry.filename)));
        await db.media.put({ name: entry.filename, blob, __remote: true });
      }
      await zip.close();
    }

    // ---- push ----
    const local = await collectLocalChanges();
    const unsynced = await db.media.where('synced').equals(0).toArray();
    let pushed = 0;
    if (local.count || unsynced.length) {
      onProgress('Uploading changes…');
      const stamp = `${Date.now()}`;
      const changes = [];
      const mediaMap = {};
      for (const [n, pack] of packMedia(unsynced).entries()) {
        onProgress(`Uploading images… ${n + 1}`);
        const writer = new ZipWriter(new Uint8ArrayWriter());
        for (const m of pack) await writer.add(m.name, new BlobReader(m.blob), { level: 0 });
        const path = `media/${deviceId}-${stamp}-${n}.zip`;
        changes.push({ path, sha: await gh.writeBlob(await writer.close()) });
        pack.forEach((m) => (mediaMap[m.name] = path));
      }
      const journalPath = `journal/${deviceId}/${stamp}.json.gz`;
      const journal = { device: deviceId, created: Date.now(), records: local.records, tombstones: local.tombstones, media: mediaMap };
      changes.push({ path: journalPath, sha: await gh.writeBlob(await gzipJson(journal)) });
      await gh.commit(changes, `Sync from ${deviceLabel()}`);
      await markPushed(local, unsynced);
      applied.add(journalPath);
      Object.assign(mediaIndex, mediaMap);
      journals.push(journalPath);
      pushed = local.count + unsynced.length;
      await save();
    }

    // ---- tidy up ----
    if (journals.length > compactAfter()) {
      onProgress('Tidying up sync history…');
      await compact(gh, journals.filter((p) => applied.has(p)), snapshots, mediaIndex, deviceId);
    }

    // ---- weekly backup ----
    if (Date.now() - (await getKV('lastBackup', 0)) > BACKUP_EVERY && (await db.cards.count())) {
      onProgress('Making weekly backup…');
      await writeRepoBackup(gh);
    }

    const lastSync = Date.now();
    await setKV('syncState', { ...(await getKV('syncState')), lastSync });
    setStatus({ state: 'idle', lastSync, error: null, lastPulled: pulled });
    return { pulled, pushed };
  } catch (err) {
    console.error('Sync failed', err);
    setStatus({ state: 'error', error: friendly(err) });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Backups in the repo

async function writeRepoBackup(gh) {
  const data = await collectBackupData();
  const path = `backups/${Date.now()}.json.gz`;
  const sha = await gh.writeBlob(await gzipJson(data));
  const { files } = await gh.files(await gh.head());
  const older = [...files.keys()].filter((p) => p.startsWith('backups/')).sort(byTimestamp);
  const drop = older.slice(0, Math.max(0, older.length + 1 - BACKUPS_KEPT));
  await gh.commit([{ path, sha }, ...drop.map((p) => ({ path: p, sha: null }))], `Backup from ${deviceLabel()}`);
  await setKV('lastBackup', Date.now());
  return { path, cards: data.cards.length };
}

async function connected() {
  const config = await getSyncConfig();
  if (!config) throw new Error('Sync is off.');
  const gh = new GitHubRepo(config);
  await gh.init();
  return gh;
}

/** Saves a dated backup of this device's cards and history into the sync repo. */
export async function backupToRepo() {
  return writeRepoBackup(await connected());
}

/** Backups in the repo, newest first: [{ path, time }] */
export async function listRepoBackups() {
  const gh = await connected();
  const { files } = await gh.files(await gh.head());
  return [...files.keys()]
    .filter((p) => p.startsWith('backups/'))
    .sort(byTimestamp)
    .reverse()
    .map((path) => ({ path, time: stampOf(path) }));
}

/** Rolls this device back to a repo backup, then syncs so other devices get anything that was deleted. */
export async function restoreFromRepo(path, onProgress = () => {}) {
  const gh = await connected();
  onProgress('Downloading backup…');
  const { files } = await gh.files(await gh.head());
  const data = await gunzipJson(await gh.readBlob(files.get(path)));
  // Images aren't in the backup; they stay on the device and in the repo's media bundles
  await restoreData(data, { clearMedia: false });
  await syncNow({ onProgress }).catch(() => {});
}

/** After "erase all", forget what was downloaded so the next sync brings everything back. */
export async function forgetPulledData() {
  if (!(await getSyncConfig())) return;
  const state = await getKV('syncState', {});
  await setKV('syncState', { ...state, applied: [], mediaIndex: {} });
  await db.tombstones.clear();
  // Become a "new" device so this device's own earlier uploads (deletions included) are replayed too
  await setKV('deviceId', newDeviceId());
}

/** Which copy of a record should win when two devices disagree. */
function isNewer(remote, local, table) {
  if (!local) return true;
  if (table === 'cards') {
    // Study progress beats everything else, so a fresh re-import can't wipe out real reviews
    const r = remote.last_review || 0;
    const l = local.last_review || 0;
    if (r !== l) return r > l;
  }
  return (remote.mod || 0) > (local.mod || 0);
}

async function applyRemote({ records = {}, tombstones = [] }) {
  await db.transaction('rw', [...SYNCED_TABLES.map((t) => db.table(t)), db.tombstones], async () => {
    for (const table of SYNCED_TABLES) {
      const rows = records[table];
      if (!rows?.length) continue;
      const existing = await db.table(table).bulkGet(rows.map((r) => r.id));
      const deleted = await db.tombstones.bulkGet(rows.map((r) => `${table}:${r.id}`));
      const winners = rows.filter((r, i) => isNewer(r, existing[i], table) && !(deleted[i] && deleted[i].mod >= r.mod));
      await db.table(table).bulkPut(winners.map((r) => ({ ...r, __remote: true })));
    }
    for (const t of tombstones) {
      const local = await db.table(t.table).get(t.id);
      if (local && (local.mod || 0) > t.mod) continue; // changed here after it was deleted there
      if (local) await db.table(t.table).delete(t.id);
      await db.tombstones.put({ ...t, dirty: 0 });
    }
  });
}

async function collectLocalChanges() {
  const records = {};
  let count = 0;
  for (const t of SYNCED_TABLES) {
    const rows = await db.table(t).where('dirty').equals(1).toArray();
    records[t] = rows.map(({ dirty, ...r }) => r);
    count += rows.length;
  }
  const tombs = await db.tombstones.where('dirty').equals(1).toArray();
  return { records, tombstones: tombs.map(({ dirty, ...t }) => t), count: count + tombs.length };
}

async function markPushed(local, media) {
  await db.transaction('rw', [...SYNCED_TABLES.map((t) => db.table(t)), db.tombstones, db.media], async () => {
    for (const t of SYNCED_TABLES) {
      const sent = local.records[t];
      if (!sent.length) continue;
      const now = await db.table(t).bulkGet(sent.map((r) => r.id));
      // Only clear the flag if nothing changed while we were uploading
      const done = now.filter((r, i) => r && r.mod === sent[i].mod);
      await db.table(t).bulkPut(done.map((r) => ({ ...r, __remote: true })));
    }
    for (const t of local.tombstones) await db.tombstones.update(t.key, { dirty: 0 });
    for (const m of media) await db.media.update(m.name, { synced: 1 });
  });
}

function packMedia(items) {
  const packs = [];
  let cur = [];
  let size = 0;
  for (const m of items) {
    if (cur.length && size + m.blob.size > PACK_LIMIT) {
      packs.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(m);
    size += m.blob.size;
  }
  if (cur.length) packs.push(cur);
  return packs;
}

async function compact(gh, covered, oldSnapshots, mediaIndex, deviceId) {
  const records = {};
  for (const t of SYNCED_TABLES) records[t] = (await db.table(t).toArray()).map(({ dirty, ...r }) => r);
  const tombstones = (await db.tombstones.toArray()).map(({ dirty, ...t }) => t);
  const snap = { device: deviceId, created: Date.now(), covers: covered, records, tombstones, media: mediaIndex };
  const path = `snapshot/${Date.now()}.json.gz`;
  const sha = await gh.writeBlob(await gzipJson(snap));
  await gh.commit(
    [{ path, sha }, ...covered.map((p) => ({ path: p, sha: null })), ...oldSnapshots.map((p) => ({ path: p, sha: null }))],
    'Compact sync history',
  );
  const state = await getKV('syncState');
  await setKV('syncState', { ...state, applied: [...new Set([...state.applied, path])] });
}

// ---------------------------------------------------------------------------

const byTimestamp = (a, b) => stampOf(a) - stampOf(b) || a.localeCompare(b);
const stampOf = (p) => Number(p.split('/').pop().split('.')[0]) || 0;

async function gzipJson(obj) {
  const stream = new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzipJson(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

function newDeviceId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'device';
  return /Mobi|Android|iPhone/.test(ua) ? `${os} phone` : `${os} computer`;
}

function friendly(err) {
  if (!navigator.onLine) return "You're offline. Will sync when you're back online.";
  if (err.status === 401) return 'GitHub rejected the token. It may have expired; make a new one and turn sync on again.';
  if (err.status === 403 && /rate limit/i.test(err.message)) return 'GitHub rate limit reached. Sync will work again in a little while.';
  if (err.status === 404) return "Can't reach the sync repo. Was it renamed or deleted, or the token's access changed?";
  return err.message || String(err);
}
