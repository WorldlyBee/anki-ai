// Study screen ergonomics: offline mic, errors closing the sheet, back gesture, tap-to-close,
// dragging/hiding the mic button, and the undo arrow.
const { chromium, devices } = require('playwright');
const path = require('path');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:4173/';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  await ctx.addInitScript(() => {
    window.SpeechRecognition = window.webkitSpeechRecognition = class {
      start() { setTimeout(() => { if (!window.__said) { window.__said = 1; this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'explain this' }], { isFinal: true })] }); } setTimeout(() => this.onend?.(), 200); }, 100); }
      abort() {} stop() {}
    };
  });
  let apiMode = 'fail';
  await ctx.route('https://api.anthropic.com/**', (r) => apiMode === 'fail'
    ? r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'boom' } }) })
    : r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sheetOpen = () => page.$eval('.sheet', (s) => s.classList.contains('open'));
  const toastText = () => page.$eval('#toast', (t) => t.textContent).catch(() => '');

  await page.goto(BASE + '#/settings');
  await page.selectOption('label:has-text("AI provider") select', 'anthropic');
  await page.fill('input[placeholder="sk-ant-…"]', 'sk-ant-test');
  await page.dispatchEvent('input[placeholder="sk-ant-…"]', 'change');
  await page.goto(BASE + '#/');
  await page.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
  await page.click('.deck-name >> text=Medicine');
  await page.waitForSelector('.answer-bar .show');
  const studyUrl = page.url();

  // 1. Offline: a short message, the sheet stays closed
  await ctx.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await page.click('.ask-fab');
  await page.waitForTimeout(400);
  console.log('offline → sheet open:', await sheetOpen(), '| message:', await toastText());
  assert.equal(await sheetOpen(), false);
  await ctx.setOffline(false);

  // 2. An error before any conversation closes the sheet and says why
  await page.click('.ask-fab');
  await page.waitForFunction(() => !document.querySelector('.sheet').classList.contains('open'), null, { timeout: 25000 }).catch(async (e) => {
    console.log('DEBUG msgs:', await page.$$eval('.msg', (m) => m.map((x) => x.className + ': ' + x.innerText.slice(0, 80))), '| toast:', await toastText(), '| errors:', errors);
    throw e;
  });
  console.log('API error → sheet closed, message:', await toastText(), '| still in deck:', page.url() === studyUrl);
  assert.equal(page.url(), studyUrl);

  // 3. Back gesture closes the sheet but stays in the deck
  await page.click('.ask-fab'); // fails again but we re-open via typing instead
  await page.waitForTimeout(300);
  await page.click('.topbar .icon-btn[aria-label=More]');
  await page.click('.popup-menu >> text=Ask Aristotle (typing)');
  assert.equal(await sheetOpen(), true);
  await page.goBack();
  await page.waitForTimeout(300);
  console.log('back gesture → sheet open:', await sheetOpen(), '| still in deck:', page.url() === studyUrl, await page.isVisible('.answer-bar'));
  assert.equal(await sheetOpen(), false);
  assert.equal(page.url(), studyUrl);

  // 4. Tapping the card closes it
  await page.click('.topbar .icon-btn[aria-label=More]');
  await page.click('.popup-menu >> text=Ask Aristotle (typing)');
  await page.mouse.click(200, 150);
  await page.waitForTimeout(300);
  console.log('tap card → sheet open:', await sheetOpen(), '| still in deck:', page.url() === studyUrl);
  assert.equal(await sheetOpen(), false);
  assert.equal(page.url(), studyUrl);

  // 5. Drag the mic up and to the left; it must not open the sheet, and the spot is remembered
  const before = await page.locator('.ask-fab').boundingBox();
  await page.mouse.move(before.x + 30, before.y + 30);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(before.x + 30 - 25 * i, before.y + 30 - 35 * i);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.locator('.ask-fab').boundingBox();
  console.log('drag moved mic by', Math.round(after.x - before.x), Math.round(after.y - before.y), '| sheet opened by drag:', await sheetOpen());
  assert.ok(after.x < before.x - 100 && after.y < before.y - 100);
  assert.equal(await sheetOpen(), false);
  await page.reload();
  await page.waitForSelector('.answer-bar .show');
  const reloaded = await page.locator('.ask-fab').boundingBox();
  console.log('position kept after reload:', Math.abs(reloaded.x - after.x) < 2 && Math.abs(reloaded.y - after.y) < 2);

  // 6. Hide it: a mic appears in the top bar instead
  await page.click('.topbar .icon-btn[aria-label=More]');
  await page.click('.popup-menu >> text=Hide mic button');
  await page.waitForTimeout(300);
  console.log('hidden → floating mic visible:', await page.isVisible('.ask-fab'), '| top-bar mic:', await page.isVisible('.topbar .icon-btn[aria-label="Ask Aristotle"]'));
  assert.equal(await page.isVisible('.ask-fab'), false);
  await page.click('.topbar .icon-btn[aria-label=More]');
  await page.click('.popup-menu >> text=Show mic button');
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible('.ask-fab'), true);

  // 7. Undo arrow: off until you answer, then puts the card back
  const undo = '.topbar .icon-btn[aria-label="Undo last answer"]';
  console.log('undo disabled before answering:', await page.isDisabled(undo));
  const front1 = await page.$eval('.card-host', (h) => h.shadowRoot.querySelector('.card').innerText);
  const counts1 = await page.innerText('.counts');
  await page.click('.answer-bar .show');
  await page.click('.ease.good');
  await page.waitForTimeout(300);
  await page.click(undo);
  await page.waitForTimeout(300);
  const front2 = await page.$eval('.card-host', (h) => h.shadowRoot.querySelector('.card').innerText);
  console.log('undo → same card back:', front1 === front2, '| counts restored:', counts1 === (await page.innerText('.counts')), '| undo disabled again:', await page.isDisabled(undo));
  assert.equal(front1, front2);
  await page.screenshot({ path: process.argv[2] || '/dev/null' }).catch(() => {});
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
