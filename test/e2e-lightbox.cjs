// Double-tap / double-click a card picture: full-screen viewer, zoom, close by tap, ✕ or back.
const { chromium, devices } = require('playwright');
const path = require('path');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:4173/';

async function toImageCard(page) {
  await page.goto(BASE);
  await page.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
  await page.click('.deck-name >> text=Medicine');
  await page.waitForSelector('.answer-bar .show');
  for (let i = 0; i < 8; i++) {
    if (await page.$eval('.card-host', (h) => !!h.shadowRoot.querySelector('img'))) return;
    await page.click('.answer-bar .show');
    await page.click('.ease.easy');
    await page.waitForSelector('.answer-bar .show');
    await page.waitForTimeout(200);
  }
  throw new Error('no image card found');
}
const imgCenter = (page) => page.$eval('.card-host', (h) => {
  const img = h.shadowRoot.querySelector('img');
  img.style.width = '200px'; // the test image is tiny; make it easy to hit
  const r = img.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const scaleOf = (page) => page.$eval('.lightbox img', (i) => new DOMMatrix(getComputedStyle(i).transform).a);

(async () => {
  const browser = await chromium.launch();
  const errors = [];

  // Phone: finger double-tap
  const phone = await (await browser.newContext({ ...devices['Pixel 7'] })).newPage();
  phone.on('pageerror', (e) => errors.push(e.message));
  await toImageCard(phone);
  const studyUrl = phone.url();
  let c = await imgCenter(phone);
  await phone.touchscreen.tap(c.x, c.y);
  await phone.waitForTimeout(400);
  console.log('single tap opens viewer:', !!(await phone.$('.lightbox')));
  assert.equal(await phone.$('.lightbox'), null);
  await phone.touchscreen.tap(c.x, c.y);
  await phone.waitForTimeout(80);
  await phone.touchscreen.tap(c.x, c.y);
  await phone.waitForSelector('.lightbox.open');
  console.log('double-tap opens viewer: true');
  const center = { x: 206, y: 450 };
  await phone.touchscreen.tap(center.x, center.y);
  await phone.waitForTimeout(80);
  await phone.touchscreen.tap(center.x, center.y);
  await phone.waitForTimeout(400);
  console.log('double-tap inside zooms to:', (await scaleOf(phone)).toFixed(2));
  assert.ok((await scaleOf(phone)) > 2);
  await phone.goBack();
  await phone.waitForTimeout(400);
  console.log('back gesture closes viewer:', !(await phone.$('.lightbox')), '| still in deck:', phone.url() === studyUrl);
  assert.equal(phone.url(), studyUrl);
  // open again and close with ✕
  c = await imgCenter(phone);
  await phone.touchscreen.tap(c.x, c.y);
  await phone.waitForTimeout(80);
  await phone.touchscreen.tap(c.x, c.y);
  await phone.waitForSelector('.lightbox.open');
  await phone.waitForTimeout(400);
  console.log('picture fills screen width:', Math.round((await phone.locator('.lightbox img').boundingBox()).width), 'of', 412);
  await phone.screenshot({ path: process.argv[2] || '/dev/null' }).catch(() => {});
  await phone.click('.lightbox-close');
  await phone.waitForTimeout(400);
  console.log('✕ closes viewer:', !(await phone.$('.lightbox')), '| still in deck:', phone.url() === studyUrl);
  assert.equal(phone.url(), studyUrl);

  // Laptop: double-click, wheel zoom, Escape
  const laptop = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  laptop.on('pageerror', (e) => errors.push(e.message));
  await toImageCard(laptop);
  c = await imgCenter(laptop);
  await laptop.mouse.dblclick(c.x, c.y);
  await laptop.waitForSelector('.lightbox.open');
  await laptop.mouse.move(640, 400);
  for (let i = 0; i < 4; i++) await laptop.mouse.wheel(0, -100);
  await laptop.waitForTimeout(200);
  console.log('laptop: double-click opens, wheel zooms to', (await scaleOf(laptop)).toFixed(2));
  await laptop.keyboard.press('Escape');
  await laptop.waitForTimeout(400);
  console.log('laptop: Escape closes:', !(await laptop.$('.lightbox')));
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
