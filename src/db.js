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
