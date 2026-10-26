// "Connect OpenRouter" end to end against a fake OpenRouter: sign-in round trip with PKCE check,
// credit display, streamed answer, and voice transcription sent as WAV.
const { chromium, devices } = require('playwright');
const crypto = require('crypto');
const path = require('path');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:4173/';

(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const ctx = await browser.newContext({ ...devices['Pixel 7'], permissions: ['microphone'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const cors = { 'access-control-allow-origin': '*' };
  let challenge = null;
  const seen = {};

  await ctx.route('https://openrouter.ai/auth**', (route) => {
    const u = new URL(route.request().url());
    challenge = u.searchParams.get('code_challenge');
    seen.auth = Object.fromEntries(u.searchParams);
    const back = new URL(u.searchParams.get('callback_url'));
    back.searchParams.set('code', 'test-code-123');
    back.searchParams.set('state', u.searchParams.get('state'));
    route.fulfill({ status: 302, headers: { location: back.toString() } });
  });
  await ctx.route('https://openrouter.ai/api/v1/**', async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const json = (status, body) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (p === '/api/v1/auth/keys') {
      const b = JSON.parse(req.postData());
      const expected = crypto.createHash('sha256').update(b.code_verifier).digest('base64url');
      seen.exchange = { code: b.code, pkceValid: expected === challenge, method: b.code_challenge_method };
      return expected === challenge && b.code === 'test-code-123' ? json(200, { key: 'sk-or-v1-test' }) : json(400, { error: 'bad' });
    }
    if (req.headers().authorization !== 'Bearer sk-or-v1-test') return json(401, { error: { message: 'no auth' } });
    if (p === '/api/v1/key') return json(200, { data: { usage: 0.63, limit: 10, limit_remaining: 9.37 } });
    if (p === '/api/v1/chat/completions') {
      const b = JSON.parse(req.postData());
      seen.chat = { model: b.model, system: b.messages[0].content.slice(0, 40), parts: b.messages[1].content.map((c) => c.type), title: req.headers()['x-title'] };
      const chunks = ['A fast ', 'heart rate, ', 'over **100 bpm**.'].map((t) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: b.model, choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'text/event-stream' }, body: chunks.join('') + 'data: [DONE]\n\n' });
    }
    if (p === '/api/v1/audio/transcriptions') {
      const b = JSON.parse(req.postData());
      const wav = Buffer.from(b.input_audio.data, 'base64');
      seen.stt = { model: b.model, format: b.input_audio.format, riff: wav.slice(0, 4).toString(), wave: wav.slice(8, 12).toString(), rate: wav.readUInt32LE(24), seconds: +((wav.length - 44) / 32000).toFixed(1) };
      return json(200, { text: 'what is tachycardia' });
    }
    return json(404, { error: { message: 'no handler ' + p } });
  });

  await page.goto(BASE + '#/settings');
  await page.waitForSelector('button:has-text("Connect OpenRouter")');
  console.log('new install defaults to OpenRouter:', await page.$eval('label:has-text("AI provider") select', (s) => s.value));
  await page.click('button:has-text("Connect OpenRouter")');
  await page.waitForFunction(() => /OpenRouter connected/.test(document.getElementById('toast')?.textContent || ''), null, { timeout: 15000 });
  console.log('auth request:', { callback: seen.auth.callback_url, method: seen.auth.code_challenge_method, label: seen.auth.key_label });
  console.log('code exchange:', seen.exchange);
  assert.ok(seen.exchange.pkceValid);
  console.log('address bar cleaned:', !page.url().includes('code='), page.url());
  await page.waitForSelector('text=$9.37 of credit left');
  console.log('credit shown:', await page.innerText('.connect, p.note:has-text("credit left")'));

  // Ask by voice: record → WAV → OpenRouter transcription → answer
  await page.selectOption('label:has-text("Dictation") select', 'whisper');
  await page.waitForTimeout(300);
  console.log('voice note:', await page.innerText('p.note:has-text("OpenRouter account")'));
  await page.goto(BASE + '#/');
  await page.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
  await page.click('.deck-name >> text=Medicine');
  await page.waitForSelector('.answer-bar .show');
  await page.click('.ask-fab');
  await page.waitForSelector('.round.listening');
  await page.waitForTimeout(1500);
  await page.click('.round.listening');
  await page.waitForSelector('.msg.ai .msg-tools', { timeout: 15000 });
  console.log('transcription request:', seen.stt);
  assert.equal(seen.stt.riff + seen.stt.wave, 'RIFFWAVE');
  console.log('chat request:', seen.chat);
  console.log('chat:', await page.$$eval('.msg', (m) => m.map((x) => x.innerText.split('\n')[0])));

  // Disconnect returns to the Connect button
  await page.goto(BASE + '#/settings');
  await page.click('button:has-text("Disconnect")');
  await page.waitForSelector('button:has-text("Connect OpenRouter")');
  console.log('disconnect works: true');
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
