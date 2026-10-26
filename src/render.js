import katex from 'katex';
import 'katex/contrib/mhchem';

// Renders a card the way Anki's template engine does: {{Field}}, {{#Field}}…{{/Field}},
// {{^Field}}, filters like {{cloze:Text}} / {{text:Field}} / {{hint:Field}} / {{type:Field}}.

const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
export const decodeEntities = (s) =>
  s.replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m]).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));

export function stripHtml(html) {
  return decodeEntities(
    html
      .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>|<\/(div|p|li|tr|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\[sound:[^\]]+\]/g, ''),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const isEmptyField = (v) => !stripHtml(v || '').trim() && !/<img|\[sound:/i.test(v || '');

// ---------- template parsing ----------

function parseTemplate(tpl) {
  const root = { children: [] };
  const stack = [root];
  const re = /\{\{([\s\S]*?)\}\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(tpl))) {
    if (m.index > last) stack.at(-1).children.push(tpl.slice(last, m.index));
    last = re.lastIndex;
    const tag = m[1].trim();
    if (tag[0] === '#' || tag[0] === '^') {
      const node = { section: tag.slice(1).trim(), inverted: tag[0] === '^', children: [] };
      stack.at(-1).children.push(node);
      stack.push(node);
    } else if (tag[0] === '/') {
      if (stack.length > 1) stack.pop();
    } else {
      stack.at(-1).children.push({ tag });
    }
  }
  if (last < tpl.length) stack.at(-1).children.push(tpl.slice(last));
  return root.children;
}

function evalNodes(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (typeof n === 'string') out += n;
    else if (n.section !== undefined) {
      const val = lookupField(n.section, ctx);
      const show = n.inverted ? isEmptyField(val) : !isEmptyField(val);
      if (show) out += evalNodes(n.children, ctx);
    } else out += evalTag(n.tag, ctx);
  }
  return out;
}

function lookupField(name, ctx) {
  if (name in ctx.fields) return ctx.fields[name];
  switch (name) {
    case 'FrontSide': return ctx.frontSide || '';
    case 'Tags': return ctx.tags.join(' ');
    case 'Type': return escapeHtml(ctx.notetypeName);
    case 'Deck': return escapeHtml(ctx.deckName);
    case 'Subdeck': return escapeHtml(ctx.deckName.split('::').pop());
    case 'Card': return escapeHtml(ctx.templateName);
    case 'CardFlag': return '';
    default: return '';
  }
}

function evalTag(tag, ctx) {
  // {{tts en_US:Field}} and friends: show the text, no speech
  if (/^tts\s/.test(tag)) tag = tag.replace(/^tts\s+[^:]*:/, '');
  const parts = tag.split(':');
  const fieldName = parts.pop().trim();
  const filters = parts.map((p) => p.trim()).reverse(); // innermost filter runs first

  if (filters.includes('type')) return renderTypeAnswer(fieldName, filters.includes('cloze'), ctx);

  let value = lookupField(fieldName, ctx);
  for (const f of filters) {
    if (f === 'text') value = escapeHtml(stripHtml(value));
    else if (f === 'cloze') value = renderCloze(value, ctx.ord + 1, ctx.side);
    else if (f === 'cloze-only') value = clozeOnly(value, ctx.ord + 1).join(', ');
    else if (f === 'hint') value = isEmptyField(value) ? '' : `<details class="hint"><summary>${escapeHtml(fieldName)}</summary>${value}</details>`;
    else if (f === 'furigana') value = value.replace(/ ?([^ >]+?)\[(.+?)\]/g, '<ruby><rb>$1</rb><rt>$2</rt></ruby>');
    else if (f === 'kana') value = value.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$2');
    else if (f === 'kanji') value = value.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$1');
  }
  return value;
}

function renderTypeAnswer(fieldName, isCloze, ctx) {
  if (ctx.stripType) return '';
  const raw = lookupField(fieldName, ctx);
  const expected = isCloze ? clozeOnly(raw, ctx.ord + 1).join(', ') : stripHtml(raw);
  if (ctx.side === 'q') return `<input type="text" class="typeans" id="typeans" autocomplete="off" autocapitalize="off" placeholder="Type your answer">`;
  const typed = (ctx.typed || '').trim();
  const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const ok = norm(typed) === norm(expected);
  return `<div class="typeans-result ${ok ? 'correct' : 'wrong'}">${
    typed ? `<div class="typed">${escapeHtml(typed)}</div>` : ''
  }${ok ? '' : `<div class="expected">${escapeHtml(expected)}</div>`}</div>`;
}

// ---------- cloze ----------

/** Parses "{{c1::text::hint}}" (nested allowed) into a tree. */
function parseCloze(text) {
  const root = { children: [] };
  const stack = [root];
  let buf = '';
  const flush = () => {
    if (buf) stack.at(-1)[stack.at(-1).inHint ? 'hint' : 'children'].push(buf);
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const open = /^\{\{c(\d+(?:,\d+)*)::/.exec(text.slice(i, i + 20));
    if (open) {
      flush();
      const node = { nums: open[1].split(',').map(Number), children: [], hint: [], inHint: false };
      stack.at(-1)[stack.at(-1).inHint ? 'hint' : 'children'].push(node);
      stack.push(node);
      i += open[0].length;
    } else if (stack.length > 1 && text.startsWith('}}', i)) {
      flush();
      stack.pop();
      i += 2;
    } else if (stack.length > 1 && !stack.at(-1).inHint && text.startsWith('::', i)) {
      flush();
      stack.at(-1).inHint = true;
      i += 2;
    } else {
      buf += text[i++];
    }
  }
  flush();
  // Unclosed clozes: treat their text as plain
  while (stack.length > 1) stack.pop();
  return root.children;
}

const nodesToText = (nodes, active, side) =>
  nodes
    .map((n) => {
      if (typeof n === 'string') return n;
      const isActive = n.nums.includes(active);
      const inner = nodesToText(n.children, active, side);
      if (!isActive) return `<span class="cloze-inactive">${inner}</span>`;
      if (side === 'q') {
        const hint = n.hint.length ? nodesToText(n.hint, active, side) : '...';
        return `<span class="cloze">[${hint}]</span>`;
      }
      return `<span class="cloze">${inner}</span>`;
    })
    .join('');

export function renderCloze(text, active, side) {
  return nodesToText(parseCloze(text), active, side);
}

function clozeOnly(text, active) {
  const out = [];
  const walk = (nodes) =>
    nodes.forEach((n) => {
      if (typeof n === 'string') return;
      if (n.nums.includes(active)) out.push(stripHtml(nodesToText(n.children, active, 'a')));
      else walk(n.children);
    });
  walk(parseCloze(text));
  return out;
}

// ---------- math & sounds ----------

export function renderMath(html) {
  const tex = (src, display) => {
    try {
      return katex.renderToString(decodeEntities(src.replace(/<br\s*\/?>/gi, ' ')), { displayMode: display, throwOnError: false });
    } catch {
      return src;
    }
  };
  return html
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, s) => tex(s, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, s) => tex(s, false));
}

const soundButtons = (html) =>
  html.replace(/\[sound:([^\]]+)\]/g, (_, f) => `<button type="button" class="sound-btn" data-sound="${escapeHtml(f)}" aria-label="Play audio"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg></button>`);

// ---------- entry point ----------

/**
 * side: 'q' (front) or 'a' (back). Returns raw HTML (sanitise before inserting into the page).
 */
export function renderCard({ notetype, note, card, deckName = '', side, typed = '' }) {
  const fields = Object.fromEntries(notetype.fields.map((name, i) => [name, note.flds[i] ?? '']));
  const tmpl = notetype.kind === 'cloze' ? notetype.templates[0] : notetype.templates[card.ord] || notetype.templates[0];
  const ctx = {
    fields, tags: note.tags || [], notetypeName: notetype.name, deckName,
    templateName: tmpl?.name || '', ord: card.ord, side: 'q', typed,
  };
  const question = evalNodes(parseTemplate(tmpl?.qfmt || ''), ctx);
  let html = question;
  if (side === 'a') {
    const frontSide = evalNodes(parseTemplate(tmpl?.qfmt || ''), { ...ctx, stripType: true });
    html = evalNodes(parseTemplate(tmpl?.afmt || ''), { ...ctx, side: 'a', frontSide });
  }
  return soundButtons(renderMath(html));
}

/** Plain-text version of a card (front and back) for sending to the AI. */
export function cardAsText({ notetype, note, card, deckName }) {
  // Skips math rendering so the AI sees the original LaTeX source
  const tmpl = notetype.kind === 'cloze' ? notetype.templates[0] : notetype.templates[card.ord] || notetype.templates[0];
  const ctx = {
    fields: Object.fromEntries(notetype.fields.map((n, i) => [n, note.flds[i] ?? ''])),
    tags: note.tags || [], notetypeName: notetype.name, deckName,
    templateName: tmpl?.name || '', ord: card.ord, side: 'q',
  };
  const front = stripHtml(evalNodes(parseTemplate(tmpl?.qfmt || ''), { ...ctx, stripType: true }));
  const back = stripHtml(evalNodes(parseTemplate(tmpl?.afmt || ''), { ...ctx, side: 'a', frontSide: '' }));
  return { front, back };
}

/** File names of images a card's fields reference. */
export function imageNames(note) {
  const names = new Set();
  for (const f of note.flds) for (const m of f.matchAll(/<img[^>]+src=["']?([^"'>\s]+)/gi)) names.add(decodeEntities(m[1]));
  return [...names];
}
