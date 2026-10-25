import { fsrs, generatorParameters, createEmptyCard, State, Rating } from 'ts-fsrs';

export { State, Rating };
const DAY = 86_400_000;

export const defaultSettings = {
  newPerDay: 20,
  revPerDay: 200,
  retention: 0.9,
  learningSteps: '1m 10m',
  relearningSteps: '10m',
  maxIntervalDays: 36500,
  rolloverHour: 4,
  learnAheadMin: 20,
};

export function makeFsrs(s) {
  const steps = (str) => str.split(/[\s,]+/).filter((x) => /^\d+(\.\d+)?[mhd]$/.test(x));
  return fsrs(
    generatorParameters({
      request_retention: Number(s.retention) || 0.9,
      maximum_interval: Number(s.maxIntervalDays) || 36500,
      enable_fuzz: true,
      enable_short_term: true,
      learning_steps: steps(s.learningSteps),
      relearning_steps: steps(s.relearningSteps),
    }),
  );
}

export function dayStart(now, rolloverHour) {
  const d = new Date(now);
  d.setHours(rolloverHour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

const safeJSON = (s) => {
  try {
    return JSON.parse(s || '{}') || {};
  } catch {
    return {};
  }
};

/** Converts an imported Anki card (with its revlog) into our FSRS-based card record. */
export function convertAnkiCard(c, crt, f) {
  const base = {
    id: c.id, nid: c.nid, did: c.did, ord: c.ord,
    reps: c.reps, lapses: c.lapses,
    suspended: c.queue === -1 ? 1 : 0,
    buriedUntil: 0, elapsed_days: 0, learning_steps: 0,
  };
  if (c.type === 0) {
    return { ...base, state: State.New, due: 0, newPos: c.due, stability: 0, difficulty: 0, scheduled_days: 0, last_review: null };
  }
  const state = c.type === 1 ? State.Learning : c.type === 3 ? State.Relearning : State.Review;
  // Review dues are day numbers counted from collection creation; learning dues are unix seconds.
  const due = c.due > 1e9 ? c.due * 1000 : (crt + c.due * 86400) * 1000;
  const data = safeJSON(c.data);
  const logs = c.revlog.filter((r) => r.type <= 4);

  let stability, difficulty;
  if (data.s && data.d) {
    // Anki already ran FSRS on this card
    stability = data.s;
    difficulty = data.d;
  } else if (logs.some((r) => r.type <= 3)) {
    // Replay the review history through FSRS to estimate memory strength
    let card = createEmptyCard(new Date(logs[0].id));
    for (const r of logs) {
      const at = new Date(r.id);
      if (r.type === 4) {
        if (r.ivl === 0) card = f.forget(card, at).card;
      } else if (r.ease >= 1 && r.ease <= 4) {
        card = f.next(card, at, r.ease).card;
      }
    }
    stability = card.stability;
    difficulty = card.difficulty;
  } else {
    // No history at all: rough guess from the old SM-2 ease factor and interval
    stability = Math.max(c.ivl, 1);
    difficulty = Math.min(10, Math.max(1, 5 + (2500 - (c.factor || 2500)) / 200));
  }
  const lastLog = [...logs].reverse().find((r) => r.type <= 3);
  const last_review = data.lrt ? data.lrt * 1000 : lastLog ? lastLog.id : state === State.Review ? due - c.ivl * DAY : Date.now();
  return {
    ...base, state, due, newPos: 0, stability, difficulty,
    scheduled_days: state === State.Review ? c.ivl : 0, last_review,
  };
}

const toFsrsCard = (c) => ({
  due: c.state === State.New ? new Date() : new Date(c.due),
  stability: c.stability,
  difficulty: c.difficulty,
  elapsed_days: c.elapsed_days || 0,
  scheduled_days: c.scheduled_days,
  learning_steps: c.learning_steps || 0,
  reps: c.reps,
  lapses: c.lapses,
  state: c.state,
  last_review: c.last_review ? new Date(c.last_review) : undefined,
});

const fromFsrsCard = (fc) => ({
  due: fc.due.getTime(),
  stability: fc.stability,
  difficulty: fc.difficulty,
  elapsed_days: fc.elapsed_days,
  scheduled_days: fc.scheduled_days,
  learning_steps: fc.learning_steps,
  reps: fc.reps,
  lapses: fc.lapses,
  state: fc.state,
  last_review: fc.last_review ? fc.last_review.getTime() : null,
});

/** The four possible outcomes for a card right now, keyed by Rating. */
export function previewCard(card, f, now = Date.now()) {
  const preview = f.repeat(toFsrsCard(card), new Date(now));
  const out = {};
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    out[r] = { card: { ...card, ...fromFsrsCard(preview[r].card) }, interval: preview[r].card.due.getTime() - now };
  }
  return out;
}

export function formatInterval(ms) {
  const min = ms / 60_000;
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${(d / 30).toFixed(1).replace('.0', '')}mo`;
  return `${(d / 365).toFixed(1).replace('.0', '')}y`;
}

/** Deck names are "A::B::C"; returns the ids of a deck and everything under it. */
export function subtreeIds(decks, rootId) {
  const root = decks.find((d) => d.id === rootId);
  if (!root) return [];
  return decks.filter((d) => d.id === rootId || d.name.startsWith(root.name + '::')).map((d) => d.id);
}

function parentChain(byId, byName, deckId, rootId) {
  const chain = [];
  let d = byId.get(deckId);
  while (d) {
    chain.push(d.id);
    if (d.id === rootId) break;
    const parentName = d.name.split('::').slice(0, -1).join('::');
    d = parentName ? byName.get(parentName) : null;
  }
  return chain;
}

/**
 * Works out today's queues for one deck (including subdecks), honouring each deck's daily limits
 * the way Anki does: a card is only available if its deck and every parent up to the chosen deck
 * still have room.
 */
export function buildQueues({ decks, rootId, cards, todayLog, settings, now = Date.now() }) {
  const ids = new Set(subtreeIds(decks, rootId));
  const byId = new Map(decks.map((d) => [d.id, d]));
  const byName = new Map(decks.map((d) => [d.name, d]));
  const chains = new Map([...ids].map((id) => [id, parentChain(byId, byName, id, rootId)]));
  const dayEnd = dayStart(now, settings.rolloverHour) + DAY;
  const limitOf = (id) => {
    const d = byId.get(id);
    return {
      new: Number(d?.newPerDay ?? settings.newPerDay),
      rev: Number(d?.revPerDay ?? settings.revPerDay),
    };
  };

  // How much each deck (counting its subdecks) has already done today
  const remaining = new Map();
  for (const id of ids) {
    const sub = new Set(subtreeIds(decks, id));
    const done = todayLog.filter((l) => sub.has(l.did));
    const lim = limitOf(id);
    remaining.set(id, {
      new: lim.new - done.filter((l) => l.prevState === State.New).length,
      rev: lim.rev - done.filter((l) => l.prevState === State.Review).length,
    });
  }

  const active = cards.filter((c) => ids.has(c.did) && !c.suspended && !(c.buriedUntil > now));
  const take = (list, kind) => {
    const out = [];
    for (const c of list) {
      const chain = chains.get(c.did);
      if (chain.every((id) => (remaining.get(id)?.[kind] ?? 0) > 0)) {
        chain.forEach((id) => remaining.get(id)[kind]--);
        out.push(c);
      }
    }
    return out;
  };

  const learning = active
    .filter((c) => (c.state === State.Learning || c.state === State.Relearning) && c.due < dayEnd)
    .sort((a, b) => a.due - b.due);
  const review = take(
    active.filter((c) => c.state === State.Review && c.due < dayEnd).sort((a, b) => a.due - b.due),
    'rev',
  );
  const fresh = take(
    active.filter((c) => c.state === State.New).sort((a, b) => a.newPos - b.newPos || a.id - b.id),
    'new',
  );
  return { learning, review, new: fresh };
}

/** Picks the next card, Anki-style: due learning cards first, then reviews mixed with new cards. */
export function pickNext(queues, settings, now = Date.now(), lastId = null) {
  const dueLearning = queues.learning.filter((c) => c.due <= now);
  const avoidRepeat = (list) => (list.length > 1 && list[0].id === lastId ? list[1] : list[0]);
  if (dueLearning.length) return { card: avoidRepeat(dueLearning) };

  const r = queues.review.length;
  const n = queues.new.length;
  if (r || n) {
    // Spread new cards evenly through the reviews
    const showNew = n && (!r || Math.random() < n / (n + r));
    return { card: showNew ? queues.new[0] : queues.review[0] };
  }

  const ahead = queues.learning.filter((c) => c.due <= now + settings.learnAheadMin * 60_000);
  if (ahead.length) return { card: avoidRepeat(ahead) };
  if (queues.learning.length) return { waitUntil: queues.learning[0].due };
  return { done: true };
}
