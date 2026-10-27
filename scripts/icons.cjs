// Generates the app icons and the Aristotle coin from one place.
// Run with `node scripts/icons.cjs` after changing colours or shapes.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const CLAY = '#c4633a'; // home-screen tile
const CREAM = '#f6eee2';
const GLAZE = '#1b1512';
const FIGURE = '#d0703f'; // red-figure terracotta on black glaze

// One unit of the Greek key, centred on the 512 canvas. `k` shrinks it for the maskable safe zone.
const meander = (k = 1) =>
  `<g transform="translate(256 256) scale(${k}) translate(-256 -264)"><path d="M128 400 V 128 H 384 V 352 H 192 V 192 H 320 V 288 H 256" fill="none" stroke="${CREAM}" stroke-width="40" stroke-linecap="square"/></g>`;
const icon = ({ rx = 0, k = 1 } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="${rx}" fill="${CLAY}"/>${meander(k)}</svg>`;

// Aristotle as a red-figure medallion; `detail` adds the glaze lines for larger sizes.
const BUST = 'M 196 304 C 172 262 170 196 204 158 C 236 122 296 114 326 142 C 340 156 346 176 344 192 L 350 204 C 352 212 356 222 362 232 L 384 262 C 387 267 384 271 378 271 L 362 272 C 366 280 364 286 358 289 C 372 296 372 308 362 314 C 374 322 372 336 360 340 C 368 352 360 366 346 366 C 348 380 334 390 320 384 C 314 398 294 400 286 388 L 296 404 C 334 412 372 430 392 470 L 120 470 C 140 430 186 410 248 402 L 254 376 C 240 378 230 366 234 352 C 222 346 222 330 232 324 L 244 334 C 226 330 206 320 196 304 Z';
const LINES = 'M222 186 q16 -14 30 0 M256 162 q16 -12 30 2 M210 224 q14 -12 28 0 M318 302 q-12 10 -4 24 M290 312 q-12 12 -4 26 M326 344 q-10 12 -2 22 M266 238 c-16 -2 -20 26 -2 30 M320 198 q14 -8 30 2';
const coin = ({ detail = false } = {}) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><clipPath id="face"><circle cx="60" cy="60" r="50"/></clipPath></defs>
<circle cx="60" cy="60" r="59" fill="${GLAZE}"/>
<g clip-path="url(#face)"><g transform="translate(58 70) scale(0.29) translate(-262 -300)"><path d="${BUST}" fill="${FIGURE}"/>${detail ? `<path d="${LINES}" fill="none" stroke="${GLAZE}" stroke-width="11" stroke-linecap="round"/>` : ''}</g></g>
<circle cx="60" cy="60" r="50" fill="none" stroke="${FIGURE}" stroke-width="3"/></svg>`;

// The talk button: the coin as a speech bubble with a small tail. A terracotta outline runs round
// the coin and tail as one shape so the tail shows on dark backgrounds; the inner ring is the coin's rim.
const TAIL = 'M30 82 L12 112 L56 98 Z';
const talkCoin = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120">
<defs><clipPath id="face"><circle cx="62" cy="56" r="46"/></clipPath></defs>
<g stroke="${FIGURE}" stroke-width="5" stroke-linejoin="round"><circle cx="62" cy="56" r="52"/><path d="${TAIL}"/></g>
<g fill="${GLAZE}"><circle cx="62" cy="56" r="52"/><path d="${TAIL}"/></g>
<g clip-path="url(#face)"><g transform="translate(60 66) scale(0.27) translate(-262 -300)"><path d="${BUST}" fill="${FIGURE}"/></g></g>
<circle cx="62" cy="56" r="46" fill="none" stroke="${FIGURE}" stroke-width="3.5"/></svg>`;

const write = (rel, s) => fs.writeFileSync(path.join(root, rel), s + '\n');
write('public/icon.svg', icon({ rx: 112 }));
write('public/coin.svg', coin({ detail: true }));
write('src/assets/coin.svg', coin());
write('src/assets/coin-talk.svg', talkCoin());

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const png = async (svg, size, file, transparent) => {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}`);
    await page.screenshot({ path: path.join(root, 'public', file), omitBackground: transparent });
  };
  await png(icon({ rx: 112 }), 192, 'icon-192.png', true);
  await png(icon({ rx: 112 }), 512, 'icon-512.png', true);
  await png(icon(), 180, 'apple-touch-icon.png', false); // iOS: square, opaque, it rounds the corners itself
  await png(icon({ k: 0.82 }), 512, 'icon-maskable-512.png', false); // key fits the 409 px safe circle
  await browser.close();
  console.log('icons written');
})();
