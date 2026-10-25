import fs from 'node:fs';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { parseApkg } from '../src/import/apkg.js';
import { convertAnkiCard, makeFsrs, defaultSettings, buildQueues, pickNext, previewCard, formatInterval, State, Rating } from '../src/scheduler.js';

const SQL = await initSqlJs();
const data = await parseApkg(new Blob([fs.readFileSync('test/fixtures/modern.apkg')]), SQL);
const f = makeFsrs(defaultSettings);
const cards = data.cards.map((c) => convertAnkiCard(c, data.crt, f));
for (const c of cards) console.log(c.id, ['new', 'learn', 'review', 'relearn'][c.state], 'due', c.due ? new Date(c.due).toISOString() : '-', 'S', c.stability?.toFixed(2), 'D', c.difficulty?.toFixed(2));

const decks = data.decks;
const root = decks.find((d) => d.name === 'Medicine').id;
let q = buildQueues({ decks, rootId: root, cards, todayLog: [], settings: defaultSettings });
console.log('queues', { learning: q.learning.length, review: q.review.length, new: q.new.length });
assert.equal(q.new.length, 5);

// Deck limit of 2 new/day on the parent caps the subdeck too
const limited = decks.map((d) => (d.id === root ? { ...d, newPerDay: 2 } : d));
q = buildQueues({ decks: limited, rootId: root, cards, todayLog: [], settings: defaultSettings });
assert.equal(q.new.length, 2);
// ...and new cards already studied today count against it
q = buildQueues({ decks: limited, rootId: root, cards, todayLog: [{ did: root, prevState: State.New }], settings: defaultSettings });
assert.equal(q.new.length, 1);

const next = pickNext(q, defaultSettings);
const pv = previewCard(next.card, f);
console.log('intervals', [1, 2, 3, 4].map((r) => formatInterval(pv[r].interval)));
assert.equal(pv[Rating.Good].card.state, State.Learning);
console.log('scheduler tests passed');
await data.close();
