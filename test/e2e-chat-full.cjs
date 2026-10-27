// Full-screen tutor chat: tap or drag the header, swipe up in the messages, and get back to the card.
const { chromium, devices } = require('playwright');
const path = require('path');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:4173/';
const SHOTS = process.env.SHOTS;

(async () => {
  const browser = await chromium.launch();
  for (const colorScheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], colorScheme });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const state = () => page.$eval('.sheet', (s) => (s.classList.contains('full') ? 'full' : s.classList.contains('open') ? 'half' : 'closed'));
    const settle = () => page.waitForTimeout(400);
    const shot = async (name) => SHOTS && page.screenshot({ path: `${SHOTS}/${colorScheme}-${name}.png` });

    await page.goto(BASE + '#/');
    await page.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
    await page.click('.deck-name >> text=Medicine');
    await page.waitForSelector('.answer-bar .show');
    const studyUrl = page.url();
    await shot('1-coin');
    const openTyping = async () => {
      await page.click('.topbar .icon-btn[aria-label=More]');
      await page.click('.popup-menu >> text=Ask Aristotle (typing)');
      await settle();
    };

    // Tap the header: full screen, and a clear way back
    await openTyping();
    assert.equal(await state(), 'half');
    await shot('2-half');
    await page.click('.sheet-head h3');
    await settle();
    assert.equal(await state(), 'full');
    assert.equal(await page.isVisible('.back-to-card'), true);
    await shot('3-full');
    await page.click('.back-to-card');
    await settle();
    assert.equal(await state(), 'closed');
    assert.equal(page.url(), studyUrl);

    // Drag the header up, then down twice: full → half → closed
    await openTyping();
    const box = await page.locator('.sheet-head').boundingBox();
    const drag = async (from, to) => {
      await page.mouse.move(box.x + 40, from);
      await page.mouse.down();
      await page.mouse.move(box.x + 40, (from + to) / 2, { steps: 4 });
      await page.mouse.move(box.x + 40, to, { steps: 4 });
      await page.mouse.up();
      await settle();
    };
    await drag(box.y + 20, box.y - 200);
    assert.equal(await state(), 'full');
    const top = (await page.locator('.sheet-head').boundingBox()).y;
    await drag(top + 20, top + 120);
    assert.equal(await state(), 'half');
    const half = (await page.locator('.sheet-head').boundingBox()).y;
    await drag(half + 20, half + 160);
    assert.equal(await state(), 'closed');

    // The back gesture leaves full screen and returns to the card
    await openTyping();
    await page.click('.sheet-head h3');
    await settle();
    await page.goBack();
    await settle();
    assert.equal(await state(), 'closed');
    assert.equal(page.url(), studyUrl);

    console.log(colorScheme, 'full-screen chat ok | errors:', errors.length ? errors : 'none');
    assert.equal(errors.length, 0);
    await ctx.close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
