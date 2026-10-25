import { ZipReader, BlobReader, Uint8ArrayWriter, BlobWriter } from '@zip.js/zip.js';
import { decompress as zstdDecompress } from 'fzstd';
import { decodeProto, protoString, protoInt } from './proto.js';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const isZstd = (b) => b.length > 4 && ZSTD_MAGIC.every((m, i) => b[i] === m);
const utf8 = new TextDecoder();

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  opus: 'audio/ogg', flac: 'audio/flac', webm: 'video/webm', mp4: 'video/mp4',
};
export const mimeFor = (name) => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

/**
 * Reads an .apkg or .colpkg file (old and new Anki export formats).
 * `SQL` is an initialised sql.js module.
 * Returns plain data plus a lazy media iterator, so big image sets never sit in memory at once.
 */
export async function parseApkg(file, SQL, onProgress = () => {}) {
  const zip = new ZipReader(new BlobReader(file));
  let entries;
  try {
    entries = await zip.getEntries();
  } catch {
    throw new Error("That doesn't look like an Anki deck. Pick an .apkg or .colpkg file exported from Anki.");
  }
  const byName = new Map(entries.map((e) => [e.filename, e]));

  const colEntry =
    byName.get('collection.anki21b') || byName.get('collection.anki21') || byName.get('collection.anki2');
  if (!colEntry) throw new Error("This doesn't look like an Anki deck (no collection inside).");

  onProgress('Reading cards…');
  let colBytes = await colEntry.getData(new Uint8ArrayWriter());
  if (isZstd(colBytes)) colBytes = zstdDecompress(colBytes);

  const sqldb = openCollection(SQL, colBytes);
  colBytes = null;
  try {
    const data = readCollection(sqldb);
    data.media = await readMediaIndex(byName);
    data.readMedia = async function* () {
      for (const { name, entry } of data.media) {
        let bytes = await entry.getData(new Uint8ArrayWriter());
        if (isZstd(bytes)) bytes = zstdDecompress(bytes);
        yield { name, blob: new Blob([bytes], { type: mimeFor(name) }) };
      }
    };
    data.close = () => zip.close();
    return data;
  } finally {
    sqldb.close();
  }
}

// Newer collections declare a custom "unicase" collation that sql.js doesn't have, which makes
// those tables unreadable. We only ever read the file, so strip it from the schema and reopen.
function openCollection(SQL, bytes) {
  let sqldb = new SQL.Database(bytes);
  const needsFix = sqldb.exec("select 1 from sqlite_master where sql like '%unicase%' limit 1").length > 0;
  if (!needsFix) return sqldb;
  sqldb.run('PRAGMA writable_schema=ON');
  sqldb.run("UPDATE sqlite_master SET sql = replace(sql, 'COLLATE unicase', '') WHERE sql LIKE '%unicase%'");
  sqldb.run('PRAGMA writable_schema=OFF');
  const fixed = sqldb.export();
  sqldb.close();
  return new SQL.Database(fixed);
}

function rows(sqldb, sql) {
  const res = sqldb.exec(sql);
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map((v) => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

function readCollection(sqldb) {
  const tables = new Set(rows(sqldb, "select name from sqlite_master where type='table'").map((r) => r.name));
  const col = rows(sqldb, 'select * from col')[0];
  const crt = col.crt; // collection creation, seconds; review due dates are days since this

  let notetypes, decks;
  if (tables.has('notetypes')) {
    ({ notetypes, decks } = readModernSchema(sqldb));
  } else {
    ({ notetypes, decks } = readLegacySchema(col));
  }

  const notes = rows(sqldb, 'select id, guid, mid, tags, flds from notes').map((n) => ({
    id: n.id,
    guid: n.guid,
    mid: n.mid,
    tags: n.tags.trim() ? n.tags.trim().split(/\s+/) : [],
    flds: n.flds.split('\x1f'),
  }));

  const revlogByCard = new Map();
  if (tables.has('revlog')) {
    for (const r of rows(sqldb, 'select id, cid, ease, ivl, type from revlog order by id')) {
      if (!revlogByCard.has(r.cid)) revlogByCard.set(r.cid, []);
      revlogByCard.get(r.cid).push(r);
    }
  }

  const cards = rows(
    sqldb,
    'select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, data from cards',
  ).map((c) => ({ ...c, revlog: revlogByCard.get(c.id) || [] }));

  // Cards sitting in a filtered deck belong to their original deck.
  for (const c of cards) {
    if (c.odid) {
      c.did = c.odid;
      if (c.odue) c.due = c.odue;
    }
  }

  // Drop the placeholder "please update Anki" note that new exports carry in their legacy file.
  const usedDecks = new Set(cards.map((c) => c.did));
  return {
    crt,
    notetypes,
    decks: decks.filter((d) => !d.filtered && (usedDecks.has(d.id) || decks.some((x) => x.name.startsWith(d.name + '::')))),
    notes,
    cards,
  };
}

function readLegacySchema(col) {
  const models = JSON.parse(col.models || '{}');
  const deckJson = JSON.parse(col.decks || '{}');
  const notetypes = Object.values(models).map((m) => ({
    id: Number(m.id),
    name: m.name,
    kind: m.type === 1 ? 'cloze' : 'normal',
    css: m.css || '',
    fields: [...m.flds].sort((a, b) => a.ord - b.ord).map((f) => f.name),
    templates: [...m.tmpls].sort((a, b) => a.ord - b.ord).map((t) => ({ name: t.name, qfmt: t.qfmt, afmt: t.afmt })),
  }));
  const decks = Object.values(deckJson).map((d) => ({ id: Number(d.id), name: d.name, filtered: !!d.dyn }));
  return { notetypes, decks };
}

function readModernSchema(sqldb) {
  const byOrd = (a, b) => a.ord - b.ord;
  const fields = rows(sqldb, 'select ntid, ord, name from fields').sort(byOrd);
  const templates = rows(sqldb, 'select ntid, ord, name, config from templates').sort(byOrd);
  const notetypes = rows(sqldb, 'select id, name, config from notetypes').map((nt) => {
    const cfg = decodeProto(nt.config);
    return {
      id: nt.id,
      name: nt.name,
      kind: protoInt(cfg, 1) === 1 ? 'cloze' : 'normal',
      css: protoString(cfg, 3),
      fields: fields.filter((f) => f.ntid === nt.id).map((f) => f.name),
      templates: templates
        .filter((t) => t.ntid === nt.id)
        .map((t) => {
          const tc = decodeProto(t.config);
          return { name: t.name, qfmt: protoString(tc, 1), afmt: protoString(tc, 2) };
        }),
    };
  });
  const decks = rows(sqldb, 'select id, name, kind from decks').map((d) => ({
    id: d.id,
    name: d.name.split('\x1f').join('::'),
    // Deck.kind is a oneof: field 1 = normal, field 2 = filtered
    filtered: d.kind ? !!decodeProto(d.kind)[2] : false,
  }));
  return { notetypes, decks };
}

async function readMediaIndex(byName) {
  const mediaEntry = byName.get('media');
  if (!mediaEntry) return [];
  let bytes = await mediaEntry.getData(new Uint8ArrayWriter());
  const list = [];
  if (isZstd(bytes)) {
    // New format: protobuf MediaEntries { repeated MediaEntry entries = 1 }
    bytes = zstdDecompress(bytes);
    const msg = decodeProto(bytes);
    (msg[1] || []).forEach((raw, i) => {
      const e = decodeProto(raw);
      const zipName = e[255] ? String(protoInt(e, 255)) : String(i);
      list.push({ name: protoString(e, 1), zipName });
    });
  } else {
    const text = utf8.decode(bytes).trim();
    if (text) {
      for (const [zipName, name] of Object.entries(JSON.parse(text))) list.push({ name, zipName });
    }
  }
  return list
    .map((m) => ({ name: m.name, entry: byName.get(m.zipName) }))
    .filter((m) => m.name && m.entry);
}

// Exposed for the backup module, which writes the same zip library.
export { ZipReader, BlobReader, Uint8ArrayWriter, BlobWriter };
