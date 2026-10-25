import fs from 'node:fs';
import initSqlJs from 'sql.js';
import assert from 'node:assert/strict';
import { parseApkg } from '../src/import/apkg.js';

const SQL = await initSqlJs();
for (const f of ['modern.apkg', 'legacy.apkg', 'full.colpkg']) {
  const data = await parseApkg(new Blob([fs.readFileSync(`test/fixtures/${f}`)]), SQL);
  const media = [];
  for await (const m of data.readMedia()) media.push(`${m.name}:${m.blob.size}:${m.blob.type}`);
  console.log(`\n== ${f}`);
  console.log('decks', data.decks.map((d) => d.name));
  console.log('notetypes', data.notetypes.map((n) => `${n.name}[${n.kind}] fields=${n.fields} tmpls=${n.templates.length} qfmt0=${JSON.stringify(n.templates[0]?.qfmt).slice(0, 40)} css=${n.css.length}`));
  console.log('notes', data.notes.length, data.notes.map((n) => n.flds[0].slice(0, 30)));
  console.log('cards', data.cards.map((c) => `ord${c.ord} type${c.type} q${c.queue} due${c.due} ivl${c.ivl} data=${c.data} revlog=${c.revlog.length}`));
  console.log('media', media);
  assert.deepEqual(data.decks.map((d) => d.name).sort(), ['Medicine', 'Medicine::Cardiology']);
  assert.equal(data.notes.length, 5);
  assert.equal(data.cards.length, 7);
  assert.deepEqual(media, ['heart.png:74:image/png']);
  assert.ok(data.notetypes.find((n) => n.name === 'Cloze').kind === 'cloze');
  await data.close();
}
console.log('parse tests passed');
