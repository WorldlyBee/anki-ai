import { db } from './db.js';
import { getSettings } from './store.js';
import { cardAsText } from './render.js';
import { aiReady, completeOnce } from './ai.js';

const SYSTEM = 'You write short, factual descriptions of flashcard decks for a tutor who will help a student study them.';
const running = new Map();

/** The top-level deck a deck belongs to; summaries live there and cover all its subdecks. */
export const rootName = (deckName) => deckName.split('::')[0];

export async function deckSummaryFor(deckName) {
  const root = await db.decks.where('name').equals(rootName(deckName)).first();
  return root?.summary || '';
}

/**
 * Reads a sample of the deck and asks the AI for a two or three sentence description:
 * subject, level, and what the cards are like. Saved on the top-level deck (and synced).
 */
export function summarizeDeck(name) {
  name = rootName(name);
  if (!running.has(name)) running.set(name, run(name).finally(() => running.delete(name)));
  return running.get(name);
}

async function run(name) {
  const settings = await getSettings();
  if (!aiReady(settings)) return '';
  const decks = (await db.decks.toArray()).filter((d) => d.name === name || d.name.startsWith(name + '::'));
  const root = decks.find((d) => d.name === name);
  if (!root) return '';
  const deckNames = new Map(decks.map((d) => [d.id, d.name]));
  const cards = await db.cards.where('did').anyOf([...deckNames.keys()]).toArray();
  if (!cards.length) return '';

  // A spread of different notes, so one long run of similar cards doesn't dominate
  const byNote = new Map();
  for (const c of cards) if (!byNote.has(c.nid)) byNote.set(c.nid, c);
  const picks = [...byNote.values()].sort(() => Math.random() - 0.5).slice(0, 24);
  const notes = new Map((await db.notes.bulkGet(picks.map((c) => c.nid))).filter(Boolean).map((n) => [n.id, n]));
  const notetypes = new Map((await db.notetypes.toArray()).map((t) => [t.id, t]));
  const clip = (s) => (s.length > 220 ? s.slice(0, 220) + '…' : s).replace(/\s+/g, ' ').trim();
  const samples = [];
  for (const card of picks) {
    const note = notes.get(card.nid);
    const notetype = note && notetypes.get(note.mid);
    if (!notetype) continue;
    try {
      const { front, back } = cardAsText({ notetype, note, card, deckName: deckNames.get(card.did) });
      samples.push(`${samples.length + 1}. FRONT: ${clip(front) || '(picture only)'} | BACK: ${clip(back) || '(picture only)'}`);
    } catch {
      // a card whose template can't render tells us nothing; skip it
    }
  }
  const subdecks = decks.filter((d) => d !== root).map((d) => d.name.slice(name.length + 2)).slice(0, 20);
  const prompt =
    `Deck name: ${name}\n` +
    (subdecks.length ? `Subdecks: ${subdecks.join('; ')}${decks.length > 21 ? '; …' : ''}\n` : '') +
    `Cards: ${cards.length}\n\nSample cards:\n${samples.join('\n')}\n\n` +
    'In two or three sentences, describe this deck: the subject, the level or exam it seems aimed at, ' +
    'and what the cards are like (for example vocabulary, cloze deletions, pictures to identify). ' +
    'Plain prose, no heading or preamble.';
  const summary = (await completeOnce({ settings, system: SYSTEM, prompt })).trim();
  if (summary) await db.decks.update(root.id, { summary });
  return summary;
}

/** Fills in any missing summaries in the background; failures are quiet and retried next time. */
export function summarizeMissing(names) {
  for (const name of new Set(names.map(rootName))) {
    deckSummaryFor(name)
      .then((s) => s || summarizeDeck(name))
      .catch((err) => console.warn('Deck summary failed:', err));
  }
}
