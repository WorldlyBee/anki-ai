// Deck summaries reach the tutor; typed follow-ups always send (while listening, or while an
// answer is still coming); the send button lights up; long answers stay pinned to their start.
const { chromium, devices } = require('playwright');
const path = require('path');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:4173/';

const sse = (text) => [
  ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
const SUMMARY = 'A small medical deck on heart rhythm terms for pre-clinical students.';
const LONG = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of a long explanation about the heart.`).join('\n\n');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.addInitScript(() => {
    // A mic that hears half a sentence and keeps listening until stopped
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() { setTimeout(() => this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'um so' }], { isFinal: false })] }), 150); }
      abort() { setTimeout(() => this.onend?.(), 10); }
      stop() { setTimeout(() => this.onend?.(), 10); }
    };
  });
  const asks = []; // the latest user message of each tutor request
  let delay = 0;
  let reply = 'Short answer.';
  await ctx.route('https://api.anthropic.com/**', async (r) => {
    const body = JSON.parse(r.request().postData());
    const isSummary = String(body.system).includes('descriptions of flashcard decks');
    if (!isSummary) {
      const last = body.messages.at(-1);
      asks.push({ text: typeof last.content === 'string' ? last.content : last.content.at(-1).text, first: JSON.stringify(body.messages[0]) });
    }
    const wait = isSummary ? 0 : delay;
    if (wait) await new Promise((res) => setTimeout(res, wait));
    await r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(isSummary ? SUMMARY : reply) }).catch(() => {});
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const settle = (ms = 400) => page.waitForTimeout(ms);

  await page.goto(BASE + '#/settings');
  await page.selectOption('label:has-text("AI provider") select', 'anthropic');
  await page.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
  await page.dispatchEvent('input[placeholder="sk-ant-…"]', 'change');
  await page.goto(BASE + '#/');
  await page.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
  await page.waitForSelector('.deck-name >> text=Medicine');

  // 1. Importing writes a summary, shown in the deck's options
  await settle(1200);
  await page.locator('.deck-row:has-text("Medicine") .icon-btn').first().click();
  const about = await page.inputValue('label:has-text("About this deck") textarea');
  console.log('summary after import:', about);
  assert.equal(about, SUMMARY);
  await page.click('.dialog-buttons >> text=Cancel');

  await page.click('.deck-name >> text=Medicine');
  await page.waitForSelector('.answer-bar .show');
  const openTyping = async () => {
    await page.click('.topbar .icon-btn[aria-label=More]');
    await page.click('.popup-menu >> text=Ask Aristotle (typing)');
    await settle(300);
  };

  // 2. The send button lights up once you type; the tutor gets the deck summary with the card
  await openTyping();
  const sendLit = () => page.$eval('.composer .round[aria-label="Send"], .composer .round[aria-label="Stop"]', (b) => b.classList.contains('primary'));
  assert.equal(await sendLit(), false);
  await page.fill('.composer textarea', 'what is this?');
  assert.equal(await sendLit(), true);
  await page.click('.composer .round[aria-label="Send"]');
  await page.waitForSelector('.msg.ai:not(.typing) >> text=Short answer.');
  console.log('send lit while typing ✓ | deck summary in context:', asks[0].first.includes(`About this deck: ${SUMMARY}`));
  assert.ok(asks[0].first.includes(`About this deck: ${SUMMARY}`));
  assert.equal(await sendLit(), false);

  // 3. A follow-up typed while the answer is still coming is sent, and answered
  delay = 1500;
  await page.fill('.composer textarea', 'first slow question');
  await page.press('.composer textarea', 'Enter');
  await settle(300);
  assert.equal(await page.getAttribute('.composer .round:last-child', 'aria-label'), 'Stop');
  delay = 0;
  reply = 'Answer to the follow-up.';
  await page.fill('.composer textarea', 'follow-up while waiting');
  await page.click('.composer .round[aria-label="Send"]');
  await page.waitForSelector('.msg.ai:not(.typing) >> text=Answer to the follow-up.');
  console.log('follow-up during an answer:', asks.at(-1).text);
  assert.equal(asks.at(-1).text, 'follow-up while waiting');

  // 4. Typing and sending while it's listening sends the text (the mic stops)
  await page.click('.composer .round[aria-label="Speak"]');
  await page.waitForSelector('.msg.pending >> text=um so');
  reply = 'Answer to the typed one.';
  await page.fill('.composer textarea', 'typed while listening');
  await page.press('.composer textarea', 'Enter');
  await page.waitForSelector('.msg.ai:not(.typing) >> text=Answer to the typed one.');
  console.log('sent while listening:', asks.at(-1).text, '| pending bubbles:', await page.locator('.msg.pending').count());
  assert.ok(asks.at(-1).text.endsWith('typed while listening'));
  assert.equal(await page.locator('.msg.pending').count(), 0);

  // 5. A long answer stays pinned to the question instead of scrolling to the bottom
  reply = LONG;
  await page.fill('.composer textarea', 'explain at length');
  await page.press('.composer textarea', 'Enter');
  await page.waitForSelector('.msg.ai:not(.typing) >> text=Paragraph 40');
  await settle(300);
  const pos = await page.$eval('.messages', (m) => {
    const q = [...m.querySelectorAll('.msg.user')].at(-1);
    return { top: q.getBoundingClientRect().top - m.getBoundingClientRect().top, atBottom: m.scrollTop + m.clientHeight >= m.scrollHeight - 4 };
  });
  console.log('long answer: question at', Math.round(pos.top), 'px from the top | scrolled to bottom:', pos.atBottom);
  assert.ok(pos.top >= 0 && pos.top < 40);
  assert.equal(pos.atBottom, false);

  console.log('errors:', errors.length ? errors : 'none');
  assert.equal(errors.length, 0);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
