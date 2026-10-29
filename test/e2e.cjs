// End-to-end smoke test on a phone-sized screen. Mocks the microphone and the Claude API.
// Usage: npx vite build && npx vite preview --port 4173 & node test/e2e.cjs [outDir]
const { chromium, devices } = require('playwright');
const path = require('path');
const out = process.argv[2] || 'test/screens';
require('fs').mkdirSync(out, { recursive: true });

const sse = (text) =>
  [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ...text.match(/.{1,12}/gs).map((t) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } }],
    ['message_stop', { type: 'message_stop' }],
  ].map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme: process.env.DARK ? 'dark' : 'light' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Fake speech recognition: "hears" one sentence, then goes quiet like Android does
  await page.addInitScript(() => {
    window.__micSession = 1;
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() {
        window.__micStarts = (window.__micStarts || 0) + 1;
        const spoken = window.__spokenFor === window.__micSession;
        window.__spokenFor = window.__micSession;
        setTimeout(() => {
          if (!spoken) {
            const mk = (t, fin) => Object.assign([{ transcript: t }], { isFinal: fin });
            this.onresult?.({ resultIndex: 0, results: [mk('why is the mitral', false)] });
            setTimeout(() => this.onresult?.({ resultIndex: 0, results: [mk('why is the mitral valve called bicuspid', true)] }), 300);
          }
          setTimeout(() => this.onend?.(), 600);
        }, 200);
      }
      abort() {}
      stop() {}
    };
  });

  let apiRequest = null;
  await page.route('https://api.anthropic.com/**', async (route) => {
    apiRequest = { headers: route.request().headers(), body: JSON.parse(route.request().postData()) };
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
      body: sse("Great question! **Bicuspid** means *two cusps*: the mitral valve has two leaflets (anterior and posterior), unlike the tricuspid valve with three.\n\n- Mnemonic: the **mitre** (a bishop's hat) has two points.\n\nCardiac output: $CO = HR \\times SV$"),
    });
  });

  await page.goto('http://localhost:4173/');
  await page.waitForSelector('.empty');
  await page.screenshot({ path: `${out}/01-empty.png` });

  // Settings: add an API key
  await page.goto('http://localhost:4173/#/settings');
  await page.selectOption('label:has-text("AI provider") select', 'anthropic'); // new installs start on OpenRouter
  await page.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
  await page.dispatchEvent('input[placeholder="sk-ant-…"]', 'change');
  await page.screenshot({ path: `${out}/02-settings.png`, fullPage: true });

  // Import the test deck
  await page.goto('http://localhost:4173/#/');
  await page.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
  await page.waitForSelector('.deck-row');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/03-decks.png` });
  const rows = await page.$$eval('.deck-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('deck rows:', rows);

  // Rename the parent deck: the subdeck should come along, and counts stay the same
  const renameDeck = async (from, to) => {
    await page.click(`.deck-row:has(.label:text-is("${from}")) .icon-btn`);
    await page.fill('.dialog label:has-text("Name") input', to);
    await page.click('.dialog button:has-text("Save")');
    await page.waitForSelector(`.deck-row .label:text-is("${to}")`);
  };
  await renameDeck('Medicine', 'Med School');
  const renamed = await page.$$eval('.deck-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('after renaming Medicine → Med School:', renamed);
  // Same counts as before (they depend on today's date, so compare rather than hard-code)
  if (renamed[0] !== rows[0].replace('Medicine', 'Med School') || renamed[1] !== rows[1]) throw new Error('rename broke the deck tree');
  await renameDeck('Med School', 'Medicine');

  // Study
  await page.click('.deck-name >> text=Medicine');
  await page.waitForSelector('.answer-bar .show');
  await page.waitForTimeout(300);
  const front = await page.$eval('.card-host', (h) => h.shadowRoot.querySelector('.card').innerText);
  console.log('front:', JSON.stringify(front));
  await page.screenshot({ path: `${out}/04-question.png` });

  // One tap on the mic: should listen, transcribe, auto-send and stream an answer
  await page.click('.ask-fab');
  await page.waitForSelector('.msg.ai:not(.typing) .msg-tools', { timeout: 10000 }).catch(async (e) => {
    console.log('DEBUG msgs', await page.$$eval('.msg', (m) => m.map((x) => x.className + ': ' + x.innerText)), 'errors', errors, 'api', !!apiRequest);
    await page.screenshot({ path: `${out}/05-chat-fail.png` });
    throw e;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/05-chat.png` });
  const msgs = await page.$$eval('.msg', (m) => m.map((x) => `${x.className}: ${x.innerText.slice(0, 80)}`));
  console.log('chat:', msgs);
  const first = apiRequest.body.messages[0];
  console.log('api: model', apiRequest.body.model, '| beta', apiRequest.headers['anthropic-beta'], '| browser header', apiRequest.headers['anthropic-dangerous-direct-browser-access']);
  console.log('api: content types', first.content.map((c) => c.type), '| effort', JSON.stringify(apiRequest.body.output_config), '| fallbacks', apiRequest.body.fallbacks);
  console.log('api: text', JSON.stringify(first.content.at(-1).text));
  console.log('api: system prompt starts', JSON.stringify(apiRequest.body.system.slice(0, 70)));
  if (!apiRequest.body.system.startsWith('You are Aristotle') || !/Review history: /.test(first.content.at(-1).text)) throw new Error('tutor prompt or review history missing');

  // Close chat, flip, answer
  await page.click('.sheet .icon-btn[aria-label=Minimise]');
  await page.waitForTimeout(400);
  await page.click('.answer-bar .show');
  await page.waitForSelector('.ease.good');
  await page.screenshot({ path: `${out}/06-answer.png` });
  const intervals = await page.$$eval('.ease', (b) => b.map((x) => x.innerText.replace('\n', ' ')));
  console.log('buttons:', intervals);
  const countsBefore = await page.innerText('.counts');
  await page.click('.ease.good');
  await page.waitForTimeout(400);
  console.log('counts before/after Good:', countsBefore, '→', await page.innerText('.counts'));

  // Undo via the menu
  await page.click('.topbar .icon-btn[aria-label=More]');
  await page.click('.popup-menu >> text=Undo');
  await page.waitForTimeout(300);
  console.log('after undo:', await page.innerText('.counts'));

  // Find the card with a picture and check the image goes to the AI too
  const frontText = () => page.$eval('.card-host', (h) => h.shadowRoot.querySelector('.card')?.innerText || '');
  for (let i = 0; i < 10 && !(await frontText()).includes('What does this show'); i++) {
    await page.click('.answer-bar .show');
    await page.click('.ease.easy');
    // wait for the next question to be painted
    await page.waitForSelector('.answer-bar .show');
    await page.waitForTimeout(200);
  }
  const imgOk = await page.$eval('.card-host', (h) => { const i = h.shadowRoot.querySelector('img'); return i && i.complete && i.naturalWidth > 0 && i.src.startsWith('blob:'); });
  console.log('image card shown, image loaded from device storage:', imgOk);
  await page.evaluate(() => (window.__micSession = 2));
  await page.click('.ask-fab');
  await page.waitForFunction(() => document.querySelectorAll('.msg.ai .msg-tools').length >= 1);
  console.log('api content for image card:', apiRequest.body.messages[0].content.map((c) => c.type + (c.source ? ':' + c.source.media_type : '')));
  await page.screenshot({ path: `${out}/08-image-card.png` });
  await page.click('.sheet .icon-btn[aria-label=Minimise]');

  // Work through every card to make sure nothing crashes
  for (let i = 0; i < 30; i++) {
    if (await page.$('.done')) break;
    await page.click('.answer-bar .show');
    await page.click('.ease.easy');
    await page.waitForTimeout(120);
  }
  await page.screenshot({ path: `${out}/07-done.png` });
  console.log('done screen:', await page.$eval('.done', (d) => d.innerText.replace(/\s+/g, ' ')).catch(() => 'not reached'));

  if (!(await page.$('.done.celebrate'))) throw new Error('no deck-complete celebration');
  console.log('streak on finish:', await page.innerText('.streak'));

  // Streaks count consecutive days: add reviews from the two previous days (but not 3 days ago)
  await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('anki-ai');
    req.onsuccess = () => {
      const tx = req.result.transaction('reviews', 'readwrite');
      const day = 86_400_000;
      for (const back of [1, 2, 4]) {
        const t = Date.now() - back * day;
        tx.objectStore('reviews').put({ id: `${t}-1`, cid: 1, did: 1, time: t, rating: 3, prevState: 2, mod: t, dirty: 0 });
      }
      tx.oncomplete = resolve;
    };
  }));
  await page.goto('http://localhost:4173/#/');
  await page.waitForSelector('.deck-row');
  console.log('deck list footer with history:', await page.innerText('.today'));
  if (!/3-day streak/.test(await page.innerText('.today'))) throw new Error('streak count wrong');
  console.log('deck rows after:', await page.$$eval('.deck-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' '))));
  console.log('today:', await page.innerText('.today'));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
