import initSqlJs from 'sql.js';
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { db, getKV, setKV, tombstone } from './db.js';
import { parseApkg } from './import/apkg.js';
import { convertAnkiCard, makeFsrs, defaultSettings, dayStart } from './scheduler.js';

export const defaultAppSettings = {
  ...defaultSettings,
  provider: 'openrouter', // new installs: easiest setup (existing users keep their saved choice)
  openrouterKey: '',
  openrouterModel: 'anthropic/claude-opus-5.5',
  anthropicKey: '',
  anthropicModel: 'claude-opus-5-5',
  effort: 'low',
  openaiKey: '',
  openaiModel: 'gpt-5-mini',
  voiceEngine: 'browser', // 'browser' (free, Chrome's built-in) or 'whisper' (OpenAI, needs key)
  whisperModel: 'gpt-4o-mini-transcribe',
  voiceLang: '',
  autoSendSeconds: 2.5,
  autoSpeak: false,
  soundEffects: true,
  sendImages: true,
  theme: 'system',
};

let settingsCache = null;
export async function getSettings() {
  if (!settingsCache) settingsCache = { ...defaultAppSettings, ...(await getKV('settings', {})) };
  return settingsCache;
}
export async function saveSettings(patch) {
  settingsCache = { ...(await getSettings()), ...patch };
  await setKV('settings', settingsCache);
  return settingsCache;
}

let sqlPromise;
const getSQL = () => (sqlPromise ||= initSqlJs({ locateFile: () => sqlWasmUrl }));

/** Imports an .apkg/.colpkg. Cards you already have keep their local scheduling. */
export async function importFile(file, onProgress = () => {}) {
  const SQL = await getSQL();
  const data = await parseApkg(file, SQL, onProgress);
  try {
    const settings = await getSettings();
    const f = makeFsrs(settings);
    onProgress(`Saving ${data.notes.length} notes…`);
    await db.transaction('rw', db.decks, db.notetypes, db.notes, db.cards, async () => {
      const localDecks = await db.decks.toArray();
      const existingDecks = new Map(localDecks.map((d) => [d.name, d]));
      const existingById = new Map(localDecks.map((d) => [d.id, d]));
      // Decks are matched by name so re-importing an updated deck merges into the same one
      const deckIdMap = new Map();
      for (const d of data.decks) {
        // By name first; by id catches a deck you've renamed since the last import
        const existing = existingDecks.get(d.name) || existingById.get(d.id);
        if (existing) deckIdMap.set(d.id, existing.id);
        else {
          await db.decks.put({ id: d.id, name: d.name });
          deckIdMap.set(d.id, d.id);
        }
      }
      // Parents must exist for the tree view even if the export left them out
      const allNames = new Set([...existingDecks.keys(), ...data.decks.map((d) => d.name)]);
      for (const d of data.decks) {
        const parts = d.name.split('::');
        for (let i = 1; i < parts.length; i++) {
          const name = parts.slice(0, i).join('::');
          if (!allNames.has(name)) {
            allNames.add(name);
            await db.decks.put({ id: deckIdForName(name), name });
          }
        }
      }
      await db.notetypes.bulkPut(data.notetypes);
      await db.notes.bulkPut(data.notes);

      const existingCards = new Set(await db.cards.where('id').anyOf(data.cards.map((c) => c.id)).primaryKeys());
      const fresh = data.cards
        .filter((c) => !existingCards.has(c.id) && deckIdMap.has(c.did))
        .map((c) => ({ ...convertAnkiCard(c, data.crt, f), did: deckIdMap.get(c.did) }));
      await db.cards.bulkPut(fresh);
    });

    let count = 0;
    let batch = [];
    for await (const m of data.readMedia()) {
      batch.push(m);
      if (batch.length >= 50) {
        await db.media.bulkPut(batch);
        count += batch.length;
        batch = [];
        onProgress(`Saving images… ${count}/${data.media.length}`);
      }
    }
    if (batch.length) await db.media.bulkPut(batch);
    return { notes: data.notes.length, cards: data.cards.length, media: data.media.length, decks: data.decks.length };
  } finally {
    await data.close();
  }
}

// Same name → same id on every device, so separately imported parents don't duplicate
function deckIdForName(name) {
  let h = 0;
  for (const ch of name) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return 9e12 + h;
}

export async function todayLog(settings) {
  const start = dayStart(Date.now(), settings.rolloverHour);
  return db.reviews.where('time').aboveOrEqual(start).toArray();
}

/**
 * Days in a row with at least one review (reviews from every synced device count). A streak is
 * still alive today if you studied yesterday, so it isn't shown as broken first thing in the morning.
 */
export async function getStreak(settings) {
  const start = (t) => dayStart(t, settings.rolloverHour);
  const prevDay = (d) => start(d - 1);
  const nextDay = (d) => start(d + 36 * 3_600_000); // lands mid-next-day, safe across DST changes
  const days = new Set((await db.reviews.orderBy('time').keys()).map(start));
  const today = start(Date.now());
  const studiedToday = days.has(today);
  let current = 0;
  for (let d = studiedToday ? today : prevDay(today); days.has(d); d = prevDay(d)) current++;
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of [...days].sort((a, b) => a - b)) {
    run = prev !== null && nextDay(prev) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { current, best, studiedToday };
}

export async function saveAnswer(updatedCard, logEntry) {
  const id = `${logEntry.time}-${logEntry.cid}`;
  await db.transaction('rw', db.cards, db.reviews, async () => {
    await db.cards.put(updatedCard);
    await db.reviews.add({ ...logEntry, id });
  });
  return id;
}

export async function undoAnswer(previousCard, logId) {
  await db.transaction('rw', db.cards, db.reviews, db.tombstones, async () => {
    // Re-stamp the old version so it counts as the newest change everywhere
    const { mod, dirty, ...card } = previousCard;
    await db.cards.put(card);
    await db.reviews.delete(logId);
    await tombstone('reviews', [logId]);
  });
}

/** Renames a deck (just its own part of the name); its subdecks follow along. */
export async function renameDeck(deckId, newLeaf) {
  newLeaf = newLeaf.trim().replace(/\s+/g, ' ');
  if (!newLeaf) throw new Error("The name can't be empty.");
  if (newLeaf.includes('::')) throw new Error('Deck names can\'t contain "::".');
  await db.transaction('rw', db.decks, async () => {
    const decks = await db.decks.toArray();
    const deck = decks.find((d) => d.id === deckId);
    const parts = deck.name.split('::');
    parts[parts.length - 1] = newLeaf;
    const newName = parts.join('::');
    if (newName === deck.name) return;
    if (decks.some((d) => d.id !== deckId && d.name.toLowerCase() === newName.toLowerCase())) {
      throw new Error(`There's already a deck called "${newLeaf}" there.`);
    }
    for (const d of decks) {
      if (d.id === deckId || d.name.startsWith(deck.name + '::')) {
        await db.decks.update(d.id, { name: newName + d.name.slice(deck.name.length) });
      }
    }
  });
}

export async function deleteDeck(deckId) {
  const decks = await db.decks.toArray();
  const root = decks.find((d) => d.id === deckId);
  const ids = decks.filter((d) => d.id === deckId || d.name.startsWith(root.name + '::')).map((d) => d.id);
  await db.transaction('rw', db.decks, db.cards, db.notes, db.tombstones, async () => {
    const cards = await db.cards.where('did').anyOf(ids).toArray();
    await db.cards.bulkDelete(cards.map((c) => c.id));
    await tombstone('cards', cards.map((c) => c.id));
    // Remove notes that no longer have any cards
    const nids = [...new Set(cards.map((c) => c.nid))];
    const stillUsed = new Set((await db.cards.where('nid').anyOf(nids).toArray()).map((c) => c.nid));
    const orphans = nids.filter((n) => !stillUsed.has(n));
    await db.notes.bulkDelete(orphans);
    await tombstone('notes', orphans);
    await db.decks.bulkDelete(ids);
    await tombstone('decks', ids);
  });
}

// Media blobs become object URLs so <img src="heart.png"> can resolve
const urlCache = new Map();
export async function mediaUrl(name) {
  if (urlCache.has(name)) return urlCache.get(name);
  const row = await db.media.get(name);
  const url = row ? URL.createObjectURL(row.blob) : null;
  urlCache.set(name, url);
  return url;
}
export async function mediaBlob(name) {
  return (await db.media.get(name))?.blob || null;
}
