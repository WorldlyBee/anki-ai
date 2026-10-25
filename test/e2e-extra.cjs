// OpenAI provider + Whisper dictation + backup/restore round trip, all with mocked network.
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const calls = [];
  await page.route('https://api.openai.com/**', async (route) => {
    const url = route.request().url();
    calls.push(url.replace('https://api.openai.com', ''));
    if (url.includes('/audio/transcriptions')) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ text: 'what does tachycardia mean' }) });
    }
    const body = JSON.parse(route.request().postData());
    calls.push(`model=${body.model} stream=${body.stream} parts=${body.messages[1].content.map((c) => c.type)}`);
    const chunks = ['Tachy', 'cardia means a ', '**fast** heart rate.'].map((t) => `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: chunks.join('') + 'data: [DONE]\n\n' });
  });

  await page.goto('http://localhost:4173/#/settings');
  await page.selectOption('select >> nth=0', 'openai');
  await page.fill('input[type=password]', 'sk-test');
  await page.dispatchEvent('input[type=password]', 'change');
  await page.selectOption('label:has-text("Dictation") select', 'whisper');
  await page.goto('http://localhost:4173/#/');
  await page.setInputFiles('input[type=file]', path.resolve('test/fixtures/legacy.apkg'));
  await page.waitForSelector('.deck-row');
  console.log('legacy import rows:', await page.$$eval('.deck-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' '))));

  await page.click('.deck-name >> text=Medicine');
  await page.waitForSelector('.answer-bar .show');
  // Whisper: tap mic, talk for a moment, tap again to send
  await page.click('.ask-fab');
  await page.waitForSelector('.round.listening');
  await page.waitForTimeout(1200);
  await page.click('.round.listening');
  await page.waitForSelector('.msg.ai .msg-tools', { timeout: 10000 });
  console.log('openai chat:', await page.$$eval('.msg', (m) => m.map((x) => x.innerText.split('\n')[0])));
  console.log('openai calls:', calls);

  // Answer a card, back up, wipe, restore, and check the history survived
  await page.click('.sheet .icon-btn[aria-label=Minimise]');
  await page.click('.answer-bar .show');
  await page.click('.ease.good');
  await page.goto('http://localhost:4173/#/settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Back up")')]);
  const file = path.join(require('os').tmpdir(), 'backup-test.zip');
  await download.saveAs(file);
  console.log('backup size:', fs.statSync(file).size, 'bytes');
  page.once('dialog', (d) => d.accept());
  await page.click('button:has-text("Erase all study data")');
  await page.click('.dialog .btn.danger');
  await page.waitForSelector('.empty');
  await page.goto('http://localhost:4173/#/settings');
  await page.setInputFiles('input[accept=".zip"]', file);
  await page.click('.dialog .btn.danger');
  await page.waitForLoadState('load');
  await page.waitForTimeout(1500);
  await page.goto('http://localhost:4173/#/');
  await page.waitForSelector('.deck-row');
  console.log('after restore:', await page.$$eval('.deck-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' '))), '|', await page.innerText('.today'));
  const keyKept = await page.evaluate(async () => {
    const req = indexedDB.open('anki-ai');
    const db = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const row = await new Promise((r) => { const g = db.transaction('kv').objectStore('kv').get('settings'); g.onsuccess = () => r(g.result); });
    return row.value.openaiKey === 'sk-test';
  });
  console.log('API key kept after restore:', keyKept);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
})();
