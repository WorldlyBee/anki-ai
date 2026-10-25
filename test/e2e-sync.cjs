// Two devices (phone + laptop) syncing through an in-memory fake of the GitHub Git Data API.
// Also checks that a phone with data from before sync existed (DB v1) uploads it correctly.
const { chromium, devices } = require('playwright');
const crypto = require('crypto');
const zlib = require('zlib');
const path = require('path');
const assert = require('assert/strict');

const BASE = process.env.BASE || 'http://localhost:4173/';
const REPO = 'tester/anki-ai-data';
const TOKEN = 'github_pat_test';

// ---------------- fake GitHub ----------------
const gh = { blobs: new Map(), trees: new Map(), commits: new Map(), head: null, requests: 0, writes: 0 };
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
function putBlob(buf) {
  const id = sha(Buffer.concat([Buffer.from('blob'), buf]));
  gh.blobs.set(id, buf);
  return id;
}
function headFiles() {
  return gh.head ? gh.trees.get(gh.commits.get(gh.head).tree) : new Map();
}
async function handleGitHub(route) {
  const req = route.request();
  const url = new URL(req.url());
  const auth = req.headers()['authorization'];
  const json = (status, body) => route.fulfill({ status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  gh.requests++;
  if (auth !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
  const p = url.pathname.replace(`/repos/${REPO}`, '');
  const m = req.method();
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  if (!url.pathname.startsWith(`/repos/${REPO}`)) return json(404, { message: 'Not Found' });
  if (m === 'GET' && p === '') return json(200, { private: true, default_branch: 'main', permissions: { push: true } });
  if (m === 'GET' && p === '/git/ref/heads/main') return gh.head ? json(200, { object: { sha: gh.head } }) : json(409, { message: 'Git Repository is empty.' });
  if (m === 'PUT' && p === '/contents/README.md') {
    const files = new Map([['README.md', putBlob(Buffer.from(body.content, 'base64'))]]);
    const t = sha('tree' + Math.random());
    gh.trees.set(t, files);
    gh.head = sha('commit' + Math.random());
    gh.commits.set(gh.head, { tree: t, parents: [] });
    return json(201, {});
  }
  let mm;
  if (m === 'GET' && (mm = p.match(/^\/git\/commits\/(\w+)$/))) return json(200, { sha: mm[1], tree: { sha: gh.commits.get(mm[1]).tree } });
  if (m === 'GET' && (mm = p.match(/^\/git\/trees\/(\w+)$/))) {
    return json(200, { sha: mm[1], tree: [...gh.trees.get(mm[1])].map(([path, s]) => ({ path, type: 'blob', sha: s, mode: '100644' })), truncated: false });
  }
  if (m === 'GET' && (mm = p.match(/^\/git\/blobs\/(\w+)$/))) {
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }, body: gh.blobs.get(mm[1]) });
  }
  if (m === 'POST' && p === '/git/blobs') {
    gh.writes++;
    return json(201, { sha: putBlob(Buffer.from(body.content, 'base64')) });
  }
  if (m === 'POST' && p === '/git/trees') {
    gh.writes++;
    const files = new Map(gh.trees.get(body.base_tree));
    for (const e of body.tree) e.sha === null ? files.delete(e.path) : files.set(e.path, e.sha);
    const t = sha('tree' + Math.random());
    gh.trees.set(t, files);
    return json(201, { sha: t });
  }
  if (m === 'POST' && p === '/git/commits') {
    gh.writes++;
    const c = sha('commit' + Math.random());
    gh.commits.set(c, { tree: body.tree, parents: body.parents });
    return json(201, { sha: c });
  }
  if (m === 'PATCH' && p === '/git/refs/heads/main') {
    if (gh.commits.get(body.sha).parents[0] !== gh.head) return json(422, { message: 'Update is not a fast forward' });
    gh.head = body.sha;
    return json(200, { object: { sha: gh.head } });
  }
  return json(404, { message: `fake GitHub: no handler for ${m} ${p}` });
}
const repoFiles = () => [...headFiles().keys()].sort();
const readRepoJson = (p) => JSON.parse(zlib.gunzipSync(gh.blobs.get(headFiles().get(p))).toString());

// ---------------- helpers ----------------
async function device(browser, name, profile) {
  const ctx = await browser.newContext(profile);
  await ctx.route('https://api.github.com/**', handleGitHub);
  await ctx.addInitScript(() => {
    const orig = IDBTransaction.prototype.objectStore;
    IDBTransaction.prototype.objectStore = function (n) {
      if (!this.objectStoreNames.contains(n)) console.log('UNHANDLED-STORE', n, 'scope=', [...this.objectStoreNames].join(','), new Error().stack.split('\n').slice(2, 9).join(' | '));
      return orig.call(this, n);
    };
  });
  await ctx.addInitScript(() => window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    console.log('UNHANDLED', typeof r, r?.constructor?.name, r?.name, r?.message, String(r).slice(0, 200), (r?.stack || '').slice(0, 300));
  }));
  const page = await ctx.newPage();
  page.on('console', (m) => m.text().startsWith('UNHANDLED') && console.log(name, m.text()));
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(`${name}: ${e.message} :: ${(e.stack || '').split('\n').slice(0, 4).join(' / ')}`));
  page.on('console', async (msg) => { if (msg.type() !== 'error' || /Sync failed|status of 409/.test(msg.text())) return; const args = await Promise.all(msg.args().map((a) => a.evaluate((v) => (v instanceof Error ? v.stack : String(v))).catch(() => '?'))); page.errors.push(`${name}: ${args.join(' ').slice(0, 300)} @ ${JSON.stringify(msg.location())} type=${msg.args().length}`); });
  return page;
}
const rows = (page) => page.$$eval('.deck-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
async function syncNow(page) {
  await page.goto(BASE + '#/settings');
  await page.waitForSelector('button:has-text("Sync now")');
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.textContent = ''; });
  await page.click('button:has-text("Sync now")');
  await page.waitForFunction(() => /Synced|Already up to date/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 15000 });
}
async function studyOne(page, deck, ease = 'good') {
  await page.goto(BASE + '#/');
  await page.click(`.deck-name >> text=${deck}`);
  await page.click('.answer-bar .show');
  await page.click(`.ease.${ease}`);
  await page.waitForTimeout(300);
}

(async () => {
  const browser = await chromium.launch();

  // ===== 1. Phone imports a deck and turns on sync =====
  const phone = await device(browser, 'phone', devices['Pixel 7']);
  await phone.goto(BASE);
  await phone.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
  await phone.waitForSelector('.deck-row');
  await phone.goto(BASE + '#/settings');
  await phone.click('summary:has-text("First-time setup")');
  await phone.fill('input[placeholder="your-username/anki-ai-data"]', REPO);
  await phone.fill('input[placeholder="github_pat_…"]', TOKEN);
  await phone.click('button:has-text("Turn on sync")');
  await phone.waitForSelector('button:has-text("Sync now")', { timeout: 15000 });
  const files1 = repoFiles();
  console.log('repo after phone turns sync on:', files1);
  const j1 = readRepoJson(files1.find((f) => f.startsWith('journal/')));
  console.log('  first journal: cards', j1.records.cards.length, '| notes', j1.records.notes.length, '| decks', j1.records.decks.length, '| media', Object.keys(j1.media));
  assert.equal(j1.records.cards.length, 7);
  assert.ok(files1.some((f) => f.startsWith('media/')));

  // Phone studies two cards; auto-sync is 30s away, so force it
  await studyOne(phone, 'Medicine', 'good');
  await studyOne(phone, 'Medicine', 'easy');
  await syncNow(phone);
  await phone.goto(BASE + '#/');
  await phone.waitForSelector('.deck-row');
  const phoneRows = await rows(phone);
  console.log('phone decks:', phoneRows, '|', await phone.innerText('.today'));

  // ===== 2. Laptop links with the pairing link (as if the QR code was scanned) =====
  const laptop = await device(browser, 'laptop', { viewport: { width: 1280, height: 800 } });
  const payload = Buffer.from(JSON.stringify({ t: TOKEN, r: REPO })).toString('base64url');
  await laptop.goto(BASE);
  await laptop.waitForSelector('.empty');
  await laptop.goto(`${BASE}#/pair/${payload}`);
  await laptop.waitForSelector('.deck-row', { timeout: 20000 });
  const laptopRows = await rows(laptop);
  console.log('laptop decks after linking:', laptopRows, '|', await laptop.innerText('.today'));
  assert.deepEqual(laptopRows, phoneRows);
  assert.ok(!laptop.url().includes('pair'), 'token removed from address bar');

  // Laptop has the image too
  const img = await laptop.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('anki-ai');
    req.onsuccess = () => {
      const g = req.result.transaction('media').objectStore('media').get('heart.png');
      g.onsuccess = () => resolve(g.result ? `${g.result.blob.size} bytes, ${g.result.blob.type}` : null);
    };
  }));
  console.log('laptop has synced image:', img);
  assert.ok(img);

  // ===== 3. Laptop studies and deletes a deck; phone picks it up =====
  await studyOne(laptop, 'Medicine', 'again');
  await laptop.goto(BASE + '#/');
  await laptop.waitForSelector('.deck-row');
  await laptop.click('.deck-row:has-text("Cardiology") .icon-btn');
  await laptop.click('.dialog button:has-text("Delete deck")');
  await laptop.click('.dialog button.danger:has-text("Delete")');
  await laptop.waitForTimeout(300);
  await syncNow(laptop);
  await laptop.goto(BASE + '#/');
  await laptop.waitForSelector('.deck-row');
  const laptopAfter = await rows(laptop);
  await syncNow(phone);
  await phone.goto(BASE + '#/');
  await phone.waitForSelector('.deck-row');
  const phoneAfter = await rows(phone);
  console.log('after laptop studies + deletes Cardiology → laptop:', laptopAfter, '| phone:', phoneAfter, '|', await phone.innerText('.today'));
  assert.deepEqual(phoneAfter, laptopAfter);
  assert.ok(!phoneAfter.some((r) => r.startsWith('Cardiology')));

  // ===== 4. Both study offline-style (no sync in between), then both sync =====
  await studyOne(phone, 'Medicine', 'good');
  await studyOne(laptop, 'Medicine', 'good');
  await syncNow(phone);
  await syncNow(laptop);
  await syncNow(phone);
  await phone.goto(BASE + '#/');
  await laptop.goto(BASE + '#/');
  await phone.waitForSelector('.deck-row');
  await laptop.waitForSelector('.deck-row');
  const [pr, lr, pt, lt] = [await rows(phone), await rows(laptop), await phone.innerText('.today'), await laptop.innerText('.today')];
  console.log('after both study then sync → phone:', pr, pt, '| laptop:', lr, lt);
  assert.deepEqual(pr, lr);
  assert.equal(pt, lt);

  // ===== 4b. Auto-sync: answer a card and wait, without pressing Sync now =====
  const before = repoFiles().filter((f) => f.startsWith('journal/')).length;
  await studyOne(phone, 'Medicine', 'hard');
  await phone.goto(BASE + '#/');
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && repoFiles().filter((f) => f.startsWith('journal/')).length === before) await new Promise((r) => setTimeout(r, 1000));
  const autoSynced = repoFiles().filter((f) => f.startsWith('journal/')).length > before;
  console.log('auto-sync uploaded the answer within ~30s:', autoSynced);
  assert.ok(autoSynced);

  // ===== 5. A phone that already had data before sync existed (database v1) =====
  const old = await device(browser, 'old-phone', devices['Pixel 7']);
  await old.goto(BASE + 'icon.svg'); // same origin, without the app running
  await old.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('anki-ai', 10); // Dexie version 1 = IndexedDB version 10
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('decks', { keyPath: 'id' }).createIndex('name', 'name');
      d.createObjectStore('notetypes', { keyPath: 'id' });
      d.createObjectStore('notes', { keyPath: 'id' }).createIndex('mid', 'mid');
      const c = d.createObjectStore('cards', { keyPath: 'id' });
      ['nid', 'did', 'state', 'due'].forEach((i) => c.createIndex(i, i));
      const r = d.createObjectStore('revlog', { keyPath: 'id', autoIncrement: true });
      ['cid', 'did', 'time'].forEach((i) => r.createIndex(i, i));
      d.createObjectStore('media', { keyPath: 'name' });
      d.createObjectStore('kv', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const d = req.result;
      const tx = d.transaction(['decks', 'notetypes', 'notes', 'cards', 'revlog'], 'readwrite');
      tx.objectStore('decks').put({ id: 77, name: 'Old Deck' });
      tx.objectStore('notetypes').put({ id: 5, name: 'Basic', kind: 'normal', css: '', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }] });
      tx.objectStore('notes').put({ id: 501, mid: 5, flds: ['Old question', 'Old answer'], tags: [] });
      tx.objectStore('cards').put({ id: 9001, nid: 501, did: 77, ord: 0, state: 2, due: Date.now() - 1000, stability: 5, difficulty: 5, reps: 3, lapses: 0, scheduled_days: 5, last_review: Date.now() - 5 * 86400000, suspended: 0, buriedUntil: 0 });
      tx.objectStore('revlog').put({ cid: 9001, did: 77, time: 1700000000000, rating: 3, prevState: 2 });
      tx.oncomplete = () => { d.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await old.goto(BASE);
  await old.waitForSelector('.deck-row');
  console.log('old phone after upgrade:', await rows(old));
  await old.goto(BASE + '#/settings');
  await old.click('summary:has-text("First-time setup")');
  await old.fill('input[placeholder="your-username/anki-ai-data"]', REPO);
  await old.fill('input[placeholder="github_pat_…"]', TOKEN);
  await old.click('button:has-text("Turn on sync")');
  await old.waitForSelector('button:has-text("Sync now")', { timeout: 15000 });
  const oldJournal = repoFiles().filter((f) => f.startsWith('journal/')).map(readRepoJson).find((j) => j.records.cards.some((c) => c.id === 9001));
  const oc = oldJournal?.records.cards.find((c) => c.id === 9001);
  console.log('old data uploaded: card', !!oc, 'mod', oc?.mod, '| stray markers', !!(oc && ('__keepMod' in oc || '__remote' in oc)), '| review ids', oldJournal?.records.reviews.map((r) => r.id));
  assert.ok(oc && oc.mod === 1 && !('__keepMod' in oc));
  assert.deepEqual(oldJournal.records.reviews.map((r) => r.id), ['1700000000000-9001']);
  await old.goto(BASE + '#/');
  await old.waitForSelector('.deck-row');
  console.log('old phone now has both:', await rows(old));
  await syncNow(phone);
  await phone.goto(BASE + '#/');
  await phone.waitForSelector('.deck-row');
  console.log('phone picks up old deck too:', await rows(phone));

  // ===== 6. History cleanup: laptop compacts while the phone is behind; a brand-new device joins after =====
  await laptop.evaluate(() => localStorage.setItem('anki-ai-compact-after', '2'));
  await studyOne(laptop, 'Medicine', 'good');
  await syncNow(laptop);
  await studyOne(laptop, 'Old Deck', 'good');
  await syncNow(laptop);
  const afterCompact = repoFiles();
  console.log('repo after compaction:', afterCompact.filter((f) => !f.startsWith('media/')));
  assert.ok(afterCompact.some((f) => f.startsWith('snapshot/')));
  assert.ok(afterCompact.filter((f) => f.startsWith('journal/')).length <= 1);
  await syncNow(phone); // phone missed the journals that were folded away
  await laptop.goto(BASE + '#/');
  await phone.goto(BASE + '#/');
  await laptop.waitForSelector('.deck-row');
  await phone.waitForSelector('.deck-row');
  const [lc, pc] = [await rows(laptop), await rows(phone)];
  console.log('after compaction → laptop:', lc, '| phone (was behind):', pc);
  assert.deepEqual(pc, lc);
  const tablet = await device(browser, 'new-device', devices['Pixel 7']);
  await tablet.goto(BASE);
  await tablet.waitForSelector('.empty');
  await tablet.goto(`${BASE}#/pair/${payload}`);
  await tablet.waitForSelector('.deck-row', { timeout: 20000 });
  const tc = await rows(tablet);
  console.log('brand-new device after compaction:', tc, '|', await tablet.innerText('.today'), '| laptop:', await laptop.innerText('.today'));
  assert.deepEqual(tc, lc);
  phone.errors.push(...tablet.errors);

  console.log(`fake GitHub: ${gh.requests} requests, ${gh.writes} writes, ${repoFiles().length} files`);
  const errors = [...phone.errors, ...laptop.errors, ...old.errors];
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
