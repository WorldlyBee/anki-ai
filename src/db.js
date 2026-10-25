import Dexie from 'dexie';

// All study data lives in IndexedDB on the device.
export const db = new Dexie('anki-ai');

db.version(1).stores({
  decks: 'id, name',
  notetypes: 'id',
  notes: 'id, mid',
  // state: 0 new, 1 learning, 2 review, 3 relearning (ts-fsrs State)
  cards: 'id, nid, did, state, due',
  revlog: '++id, cid, did, time',
  media: 'name',
  kv: 'key',
});

// v2: sync support. Every synced record carries `mod` (last change time, used to pick the newest
// version when two devices disagree) and `dirty` (1 = changed here, not uploaded yet).
// Reviews get globally unique ids so two devices can never collide.
db.version(2)
  .stores({
    decks: 'id, name, dirty',
    notetypes: 'id, dirty',
    notes: 'id, mid, dirty',
    cards: 'id, nid, did, state, due, dirty',
    reviews: 'id, cid, did, time, dirty',
    tombstones: 'key, dirty',
    media: 'name, synced',
  })
  .upgrade(async (tx) => {
    // Everything that existed before sync still needs uploading once. mod 1 = "very old", so any
    // real change on another device wins (cards are compared by study progress first anyway).
    // (__keepMod stops the stamping hook below from overwriting mod with "now")
    for (const t of ['decks', 'notetypes', 'notes', 'cards']) await tx.table(t).toCollection().modify({ mod: 1, dirty: 1, __keepMod: true });
    await tx.table('media').toCollection().modify({ synced: 0 });
    const old = await tx.table('revlog').toArray();
    await tx.table('reviews').bulkAdd(old.map(({ id, ...r }) => ({ ...r, id: `${r.time}-${r.cid}`, mod: 1, dirty: 1 })));
  });
db.version(3).stores({ revlog: null });

export const SYNCED_TABLES = ['decks', 'notetypes', 'notes', 'cards', 'reviews'];

// Local writes are stamped automatically. Writes coming from another device carry `__remote`
// so they keep that device's timestamp and don't get re-uploaded.
for (const name of SYNCED_TABLES) {
  db.table(name).hook('creating', (_key, obj) => {
    if (obj.__remote) {
      delete obj.__remote;
      obj.dirty = 0;
    } else {
      obj.mod = Date.now();
      obj.dirty = 1;
      notifyChange();
    }
  });
  db.table(name).hook('updating', (mods) => {
    if (mods.__remote) return { __remote: undefined, dirty: 0 };
    if (mods.__keepMod) return { __keepMod: undefined, dirty: 1 };
    notifyChange();
    return { mod: Date.now(), dirty: 1 };
  });
}
db.media.hook('creating', (_key, obj) => {
  if (obj.__remote) {
    delete obj.__remote;
    obj.synced = 1;
  } else {
    obj.synced = 0;
    notifyChange();
  }
});

/** Queues every local record for upload without making it look newer (used when sync is first turned on). */
export async function markAllDirty() {
  await db.transaction('rw', [...SYNCED_TABLES.map((t) => db.table(t)), db.media, db.tombstones], async () => {
    for (const t of SYNCED_TABLES) await db.table(t).toCollection().modify({ __keepMod: true });
    await db.media.toCollection().modify({ synced: 0 });
    await db.tombstones.toCollection().modify({ dirty: 1 });
  });
}

/** Records a deletion so other devices delete it too. Call inside the same transaction. */
export function tombstone(table, ids) {
  const now = Date.now();
  notifyChange();
  return db.tombstones.bulkPut(ids.map((id) => ({ key: `${table}:${id}`, table, id, mod: now, dirty: 1 })));
}

// The sync module listens for local changes to schedule an upload
const changeListeners = new Set();
export const onLocalChange = (fn) => changeListeners.add(fn);
let notifyPending = false;
function notifyChange() {
  if (notifyPending) return;
  notifyPending = true;
  // setTimeout (not a microtask) so listeners run outside the Dexie transaction that triggered this
  setTimeout(() => {
    notifyPending = false;
    changeListeners.forEach((fn) => fn());
  }, 0);
}

export async function getKV(key, fallback = undefined) {
  const row = await db.kv.get(key);
  return row ? row.value : fallback;
}

export async function setKV(key, value) {
  await db.kv.put({ key, value });
}

// Ask the browser not to evict our data when storage runs low.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch {}
}
