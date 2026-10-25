import DOMPurify from 'dompurify';
import katexCss from 'katex/dist/katex.min.css?inline';
import { db } from '../db.js';
import { getSettings, todayLog, saveAnswer, undoAnswer, mediaUrl, getStreak } from '../store.js';
import { buildQueues, pickNext, previewCard, formatInterval, makeFsrs, subtreeIds, dayStart, State, Rating } from '../scheduler.js';
import { renderCard } from '../render.js';
import { h, icon, toast, menu } from './dom.js';
import { ChatSheet } from './chat.js';
import { navigate, onLeave } from '../router.js';
import { isDarkTheme } from '../theme.js';
import { quoteOfTheDay } from '../quotes.js';
import { setSoundsEnabled, playPageTurn, playRated, playComplete } from '../sounds.js';

const BASE_CARD_CSS = `
:host { display: block; }
.card {
  font-family: arial; font-size: 20px; line-height: 1.5; text-align: center; color: black; background-color: white;
  padding: 20px 16px 160px; min-height: 100%; box-sizing: border-box; overflow-wrap: anywhere;
}
img { max-width: 100%; height: auto; }
.cloze { font-weight: bold; color: blue; }
.nightMode .cloze { color: lightblue; }
hr#answer { margin: 18px 0; border: 0; border-top: 1px solid rgba(127,127,127,.4); }
.card.nightMode { color: #ececec; background-color: #1d1d1f; }
.nightMode a { color: #8ab4ff; }
input.typeans { font: inherit; width: 100%; max-width: 420px; padding: 8px 10px; border-radius: 8px; border: 1px solid #999; margin-top: 12px; box-sizing: border-box; }
.typeans-result { display: inline-block; margin: 8px 0; font-family: monospace; font-size: 0.95em; }
.typeans-result .typed { padding: 2px 8px; border-radius: 4px; }
.typeans-result.correct .typed { background: rgba(46,157,79,.25); }
.typeans-result.wrong .typed { background: rgba(216,74,60,.25); text-decoration: line-through; }
.typeans-result .expected { padding: 2px 8px; margin-top: 4px; background: rgba(46,157,79,.25); border-radius: 4px; }
.sound-btn { font-size: 16px; width: 40px; height: 40px; border-radius: 50%; border: 0; background: #1e64c8; color: #fff; vertical-align: middle; margin: 2px; cursor: pointer; }
details.hint summary { color: #1e64c8; cursor: pointer; }
`;

export async function renderStudy(app, deckId) {
  const settings = await getSettings();
  setSoundsEnabled(settings.soundEffects);
  const f = makeFsrs(settings);
  const decks = await db.decks.toArray();
  const deck = decks.find((d) => d.id === deckId);
  if (!deck) return navigate('#/');
  const ids = subtreeIds(decks, deckId);
  let cards = await db.cards.where('did').anyOf(ids).toArray();
  let log = await todayLog(settings);
  const notetypes = new Map((await db.notetypes.toArray()).map((n) => [n.id, n]));
  const deckNames = new Map(decks.map((d) => [d.id, d.name]));
  const noteCache = new Map();
  const getNote = async (nid) => {
    if (!noteCache.has(nid)) noteCache.set(nid, await db.notes.get(nid));
    return noteCache.get(nid);
  };

  // Screen state
  let current = null; // { card, note, notetype }
  let revealed = false;
  let preview = null;
  let typed = '';
  let shownAt = 0;
  let lastId = null;
  let waitTimer = null;
  const undoStack = [];
  // This session, for the "deck complete" screen
  let sessionCards = 0;
  let sessionStart = 0;

  // ---- layout ----
  const countsEl = h('span', { class: 'counts' });
  const menuBtn = h('button', { class: 'icon-btn', 'aria-label': 'More', html: icon('more').outerHTML });
  const top = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn', 'aria-label': 'Back', html: icon('back').outerHTML, onclick: () => navigate('#/') }),
    h('h1', {}, deck.name.split('::').at(-1)),
    countsEl,
    menuBtn,
  );
  const host = h('div', { class: 'card-host' });
  const shadow = host.attachShadow({ mode: 'open' });
  const cardScroll = h('div', { class: 'card-scroll' }, host);
  const bar = h('div', { class: 'answer-bar' });
  const askBtn = h('button', { class: 'ask-fab', 'aria-label': 'Ask the AI about this card', html: icon('mic').outerHTML });
  const study = h('main', { class: 'study' }, cardScroll, askBtn, bar);
  app.replaceChildren(top, study);

  const chat = new ChatSheet(
    study,
    () => current && { notetype: current.notetype, note: current.note, card: current.card, deckName: deckNames.get(current.card.did) || '', revealed },
    () => {
      askBtn.querySelector('.badge')?.remove();
      if (chat.hasConversation && !chat.isOpen) askBtn.append(h('span', { class: 'badge' }));
    },
  );
  // One tap: open the chat with the card attached and start listening straight away
  askBtn.onclick = () => current && chat.open({ listen: true });

  menuBtn.onclick = (e) =>
    menu(e.currentTarget, [
      { label: 'Undo', disabled: !undoStack.length, action: undo },
      { label: 'Ask the AI (typing)', disabled: !current, action: () => chat.open() },
      { label: 'Bury card (until tomorrow)', disabled: !current, action: () => setCardFlag('bury') },
      { label: 'Suspend card', disabled: !current, action: () => setCardFlag('suspend') },
    ]);

  // ---- rendering ----
  async function paintCard(side) {
    const { card, note, notetype } = current;
    let html = renderCard({ notetype, note, card, deckName: deckNames.get(card.did) || '', side, typed });
    html = DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
    // Point <img src="file.png"> at the media stored on the device
    const names = [...new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1]))];
    const urls = new Map(await Promise.all(names.map(async (n) => [n, await mediaUrl(decodeURIComponent(n))])));
    html = html.replace(/(<img[^>]+src=")([^"]+)"/gi, (m, pre, n) => (urls.get(n) ? `${pre}${urls.get(n)}"` : m));
    const night = isDarkTheme() ? 'nightMode night_mode' : '';
    shadow.innerHTML = `<style>${katexCss}${BASE_CARD_CSS}${notetype.css || ''}</style><div class="card card${card.ord + 1} ${night}">${html}</div>`;
    shadow.querySelectorAll('.sound-btn').forEach((b) =>
      b.addEventListener('click', async () => {
        const url = await mediaUrl(b.dataset.sound);
        if (url) new Audio(url).play().catch(() => {});
      }),
    );
    const input = shadow.querySelector('#typeans');
    if (input && side === 'q') {
      input.addEventListener('keydown', (e) => e.key === 'Enter' && reveal());
    }
    cardScroll.scrollTop = 0;
  }

  function paintCounts(queues) {
    const kind = current ? (current.card.state === State.New ? 'n' : current.card.state === State.Review ? 'r' : 'l') : '';
    const span = (cls, n) => h('span', { class: `${cls} ${kind === cls ? 'cur' : ''}` }, n);
    countsEl.replaceChildren(span('n', queues.new.length), ' + ', span('l', queues.learning.length), ' + ', span('r', queues.review.length));
  }

  function paintQuestionBar() {
    bar.replaceChildren(h('button', { class: 'show', onclick: reveal }, 'Show Answer'));
  }

  function paintAnswerBar() {
    const btn = (rating, label, cls) =>
      h('button', { class: `ease ${cls}`, onclick: () => answer(rating) }, h('small', {}, formatInterval(preview[rating].interval)), h('b', {}, label));
    bar.replaceChildren(
      btn(Rating.Again, 'Again', 'again'),
      btn(Rating.Hard, 'Hard', 'hard'),
      btn(Rating.Good, 'Good', 'good'),
      btn(Rating.Easy, 'Easy', 'easy'),
    );
  }

  // ---- flow ----
  async function showNext() {
    clearTimeout(waitTimer);
    const now = Date.now();
    const queues = buildQueues({ decks, rootId: deckId, cards, todayLog: log, settings, now });
    const pick = pickNext(queues, settings, now, lastId);
    if (!pick.card) {
      current = null;
      paintCounts(queues);
      chat.setCard(null);
      chat.close();
      askBtn.hidden = true;
      bar.replaceChildren(h('button', { class: 'show', onclick: () => navigate('#/') }, 'Back to decks'));
      const msg = pick.waitUntil
        ? `More learning cards are due in ${formatInterval(pick.waitUntil - now)}. Stay here and they'll appear, or come back later.`
        : 'You have finished this deck for now.';
      shadow.innerHTML = `<style>${BASE_CARD_CSS}</style>`;
      const q = quoteOfTheDay();
      const finished = sessionCards > 0 && !pick.waitUntil;
      const streak = await getStreak(settings);
      cardScroll.replaceChildren(h('div', { class: `done ${finished ? 'celebrate' : ''}` },
        h('img', { class: 'coin', src: 'icon-192.png', alt: '' }),
        h('h2', {}, finished ? 'Deck complete!' : 'Congratulations!'),
        finished ? h('p', {}, sessionSummary()) : h('p', {}, msg),
        streak.current > 0 && h('div', { class: 'streak' },
          h('div', { class: 'streak-count' }, `🔥 ${streak.current}-day streak`),
          h('div', { class: 'streak-note' }, streakNote(streak)),
        ),
        h('blockquote', { class: 'quote' }, h('p', {}, `“${q.text}”`), h('cite', {}, `Aristotle, ${q.source}`)),
      ));
      if (finished) {
        playComplete();
        sessionCards = 0; // celebrate once per finish
      }
      if (pick.waitUntil) {
        waitTimer = setTimeout(() => {
          cardScroll.replaceChildren(host);
          showNext();
        }, Math.max(1000, pick.waitUntil - now - settings.learnAheadMin * 60_000));
      }
      return;
    }
    askBtn.hidden = false;
    cardScroll.replaceChildren(host);
    const card = pick.card;
    const note = await getNote(card.nid);
    const notetype = note && notetypes.get(note.mid);
    if (!note || !notetype) {
      // Orphaned card: skip it rather than getting stuck
      cards = cards.filter((c) => c.id !== card.id);
      return showNext();
    }
    current = { card, note, notetype };
    revealed = false;
    typed = '';
    preview = null;
    shownAt = Date.now();
    chat.setCard(card.id);
    paintCounts(queues);
    await paintCard('q');
    paintQuestionBar();
  }

  async function reveal() {
    if (!current || revealed) return;
    typed = shadow.querySelector('#typeans')?.value || '';
    revealed = true;
    playPageTurn();
    preview = previewCard(current.card, f);
    await paintCard('a');
    paintAnswerBar();
  }

  async function answer(rating) {
    if (!current || !revealed) return;
    playRated(rating);
    const now = Date.now();
    const prev = current.card;
    const updated = { ...preview[rating].card, buriedUntil: 0 };
    const entry = {
      cid: prev.id, did: prev.did, time: now, rating,
      prevState: prev.state, state: updated.state, due: updated.due,
      stability: updated.stability, difficulty: updated.difficulty,
      duration: Math.min(now - shownAt, 120_000),
    };
    const logId = await saveAnswer(updated, entry);
    if (!sessionCards) sessionStart = now;
    sessionCards++;
    undoStack.push({ prev, logId });
    if (undoStack.length > 20) undoStack.shift();
    cards = cards.map((c) => (c.id === prev.id ? updated : c));
    log.push({ ...entry, id: logId });
    lastId = prev.id;
    showNext();
  }

  function sessionSummary() {
    const mins = Math.max(1, Math.round((Date.now() - sessionStart) / 60_000));
    return `${sessionCards} card${sessionCards === 1 ? '' : 's'} in ${mins} minute${mins === 1 ? '' : 's'}. Nicely done.`;
  }

  function streakNote({ current, best }) {
    if (current === 1) return 'Day one. Come back tomorrow to keep it going.';
    if (current >= best) return current === best && best > 1 ? 'Your longest streak yet.' : 'Keep it going.';
    return `Your best is ${best} days.`;
  }

  async function undo() {
    const last = undoStack.pop();
    if (!last) return;
    sessionCards = Math.max(0, sessionCards - 1);
    await undoAnswer(last.prev, last.logId);
    cards = cards.map((c) => (c.id === last.prev.id ? last.prev : c));
    log = log.filter((l) => l.id !== last.logId);
    toast('Undone');
    // Put the undone card straight back on screen
    clearTimeout(waitTimer);
    const note = await getNote(last.prev.nid);
    current = { card: last.prev, note, notetype: notetypes.get(note.mid) };
    revealed = false;
    typed = '';
    shownAt = Date.now();
    askBtn.hidden = false;
    cardScroll.replaceChildren(host);
    chat.setCard(last.prev.id);
    paintCounts(buildQueues({ decks, rootId: deckId, cards, todayLog: log, settings }));
    await paintCard('q');
    paintQuestionBar();
  }

  async function setCardFlag(kind) {
    const c = current.card;
    const patch = kind === 'bury' ? { buriedUntil: dayStart(Date.now(), settings.rolloverHour) + 86_400_000 } : { suspended: 1 };
    await db.cards.update(c.id, patch);
    cards = cards.map((x) => (x.id === c.id ? { ...x, ...patch } : x));
    toast(kind === 'bury' ? 'Card buried until tomorrow' : 'Card suspended');
    showNext();
  }

  // Keyboard shortcuts (handy on desktop): space/enter = show answer / Good, 1–4 = ratings, u = undo
  const onKey = (e) => {
    if (e.target.closest?.('textarea, input') || e.composedPath?.()[0]?.tagName === 'INPUT') return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      revealed ? answer(Rating.Good) : reveal();
    } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) answer(Number(e.key));
    else if (e.key === 'u') undo();
  };
  document.addEventListener('keydown', onKey);
  onLeave(() => {
    document.removeEventListener('keydown', onKey);
    clearTimeout(waitTimer);
    chat.setCard(null);
  });

  await showNext();
}
