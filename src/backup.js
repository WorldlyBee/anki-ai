import { ZipWriter, BlobWriter, BlobReader, ZipReader, TextReader, TextWriter } from '@zip.js/zip.js';
import { db, setKV } from './db.js';
import { getSettings } from './store.js';
import { mimeFor } from './import/apkg.js';

const VERSION = 1;

/** Everything (decks, cards, history, images) in one .zip. API keys are left out on purpose. */
export async function exportBackup(onProgress = () => {}) {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { level: 0 });
  const { anthropicKey, openaiKey, ...settings } = await getSettings();
  const mediaNames = await db.media.toCollection().primaryKeys();
  const data = {
    version: VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    decks: await db.decks.toArray(),
    notetypes: await db.notetypes.toArray(),
    notes: await db.notes.toArray(),
    cards: await db.cards.toArray(),
    reviews: await db.reviews.toArray(),
    media: mediaNames,
  };
  await writer.add('data.json', new TextReader(JSON.stringify(data)));
  for (let i = 0; i < mediaNames.length; i++) {
    const row = await db.media.get(mediaNames[i]);
    await writer.add(`media/${i}`, new BlobReader(row.blob));
    if (i % 25 === 0) onProgress(`Packing images… ${i}/${mediaNames.length}`);
  }
  return writer.close();
}

export async function restoreBackup(file, onProgress = () => {}) {
  const zip = new ZipReader(new BlobReader(file));
  const entries = await zip.getEntries();
  const dataEntry = entries.find((e) => e.filename === 'data.json');
  if (!dataEntry) throw new Error("That file isn't a backup from this app.");
  const data = JSON.parse(await dataEntry.getData(new TextWriter()));
  const byName = new Map(entries.map((e) => [e.filename, e]));
  const current = await getSettings();

  await db.transaction('rw', [db.decks, db.notetypes, db.notes, db.cards, db.reviews, db.media, db.kv], async () => {
    await Promise.all([db.decks.clear(), db.notetypes.clear(), db.notes.clear(), db.cards.clear(), db.reviews.clear(), db.media.clear()]);
    // Backups made before sync existed have numeric "revlog" entries
    const reviews = data.reviews || (data.revlog || []).map(({ id, ...r }) => ({ ...r, id: `${r.time}-${r.cid}` }));
    // Strip sync stamps so restored data is uploaded as fresh changes
    const fresh = (rows) => rows.map(({ mod, dirty, ...r }) => r);
    await db.decks.bulkPut(fresh(data.decks));
    await db.notetypes.bulkPut(fresh(data.notetypes));
    await db.notes.bulkPut(fresh(data.notes));
    await db.cards.bulkPut(fresh(data.cards));
    await db.reviews.bulkPut(fresh(reviews));
    // Keep the API keys already on this device
    await setKV('settings', { ...data.settings, anthropicKey: current.anthropicKey, openaiKey: current.openaiKey });
  });

  for (let i = 0; i < data.media.length; i++) {
    const entry = byName.get(`media/${i}`);
    if (!entry) continue;
    const blob = await entry.getData(new BlobWriter());
    await db.media.put({ name: data.media[i], blob: new Blob([blob], { type: mimeFor(data.media[i]) }) });
    if (i % 25 === 0) onProgress(`Restoring images… ${i}/${data.media.length}`);
  }
  await zip.close();
}
