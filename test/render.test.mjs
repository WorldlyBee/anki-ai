import { renderCard, renderCloze, cardAsText, stripHtml } from '../src/render.js';
import assert from 'node:assert/strict';

const cloze = { name: 'Cloze', kind: 'cloze', css: '', fields: ['Text', 'Back Extra'],
  templates: [{ name: 'Cloze', qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>\n{{Back Extra}}' }] };
const note = { flds: ['The {{c1::mitral::valve name}} valve sits between the LA and {{c2::left ventricle}}.', 'bicuspid'], tags: [] };
let q = renderCard({ notetype: cloze, note, card: { ord: 0 }, side: 'q' });
assert.match(q, /\[valve name\]/); assert.match(q, /cloze-inactive">left ventricle/);
let a = renderCard({ notetype: cloze, note, card: { ord: 0 }, side: 'a' });
assert.match(a, /class="cloze">mitral/); assert.match(a, /bicuspid/);
q = renderCard({ notetype: cloze, note, card: { ord: 1 }, side: 'q' });
assert.match(q, /\[\.\.\.\]/); assert.match(q, /mitral/);

// nested + multi-number clozes
assert.equal(stripHtml(renderCloze('{{c1::outer {{c2::inner}} text}}', 2, 'q')), 'outer [...] text');
assert.equal(stripHtml(renderCloze('{{c1,2::shared}} x', 2, 'q')), '[...] x');

const basic = { name: 'Basic', kind: 'normal', css: '', fields: ['Front', 'Back', 'Extra'],
  templates: [{ name: 'Card 1', qfmt: '{{Front}}{{#Extra}}<i>{{Extra}}</i>{{/Extra}}{{^Extra}}NOEXTRA{{/Extra}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}} {{hint:Back}} {{text:Front}}' }] };
const bn = { flds: ['<b>Q</b> \\(x^2\\) [sound:a.mp3]', 'A', ''], tags: ['t1'] };
q = renderCard({ notetype: basic, note: bn, card: { ord: 0 }, side: 'q' });
assert.match(q, /NOEXTRA/); assert.match(q, /katex/); assert.match(q, /data-sound="a.mp3"/);
a = renderCard({ notetype: basic, note: bn, card: { ord: 0 }, side: 'a' });
assert.match(a, /<hr id=answer>A/); assert.match(a, /<details class="hint">/);

const typeNt = { name: 'Type', kind: 'normal', css: '', fields: ['Front', 'Back'],
  templates: [{ name: 'C', qfmt: '{{Front}} {{type:Back}}', afmt: '{{Front}}<hr id=answer>{{type:Back}}' }] };
const tn = { flds: ['Capital of France?', 'Paris'] };
assert.match(renderCard({ notetype: typeNt, note: tn, card: { ord: 0 }, side: 'q' }), /<input/);
assert.match(renderCard({ notetype: typeNt, note: tn, card: { ord: 0 }, side: 'a', typed: 'paris' }), /correct/);
assert.match(renderCard({ notetype: typeNt, note: tn, card: { ord: 0 }, side: 'a', typed: 'Lyon' }), /wrong[\s\S]*Paris/);

console.log(cardAsText({ notetype: cloze, note, card: { ord: 0 }, deckName: 'Med' }));
console.log(cardAsText({ notetype: basic, note: bn, card: { ord: 0 }, deckName: 'Med' }));
console.log('render tests passed');
