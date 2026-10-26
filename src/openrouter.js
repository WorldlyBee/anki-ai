// OpenRouter: one account for answers (Claude, GPT, …) and voice transcription, paid with prepaid
// credit. "Connect" uses OAuth with PKCE entirely in the browser, so there's no server and no
// key to copy and paste.
import OpenAI from 'openai';

const API = 'https://openrouter.ai/api/v1';
const PENDING = 'aristotle-openrouter-pkce';

export const OPENROUTER_MODELS = [
  ['anthropic/claude-opus-5.5', 'Claude Opus 5.5 (smartest, ~2¢ per question)'],
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5 (great, ~1¢)'],
  ['anthropic/claude-haiku-5.5', 'Claude Haiku 5.5 (fast & cheapest, <0.1¢)'],
  ['openai/gpt-4o-mini', 'GPT-4o mini (cheap)'],
];
export const ADD_CREDITS_URL = 'https://openrouter.ai/settings/credits';

const base64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Sends the user to OpenRouter to sign in and approve a key for Aristotle. */
export async function connectOpenRouter() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  // localStorage (not sessionStorage) survives the round trip even if the phone reopens the app
  localStorage.setItem(PENDING, JSON.stringify({ verifier, state, at: Date.now() }));
  const params = new URLSearchParams({
    callback_url: location.origin + location.pathname,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    key_label: 'Aristotle',
  });
  location.href = `https://openrouter.ai/auth?${params}`;
}

/**
 * If we've just come back from OpenRouter (?code=…), trades the code for a key.
 * Returns the key, or null when this isn't a callback.
 */
export async function finishOpenRouterConnect() {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return null;
  // Clean the address bar whatever happens, so a reload doesn't retry a used code
  history.replaceState(null, '', location.pathname + (location.hash || '#/'));
  let pending;
  try {
    pending = JSON.parse(localStorage.getItem(PENDING) || 'null');
  } finally {
    localStorage.removeItem(PENDING);
  }
  if (!pending) throw new Error('That sign-in link has already been used. Tap "Connect" again.');
  if (url.searchParams.get('state') && url.searchParams.get('state') !== pending.state) {
    throw new Error('Sign-in check failed. Tap "Connect" to try again.');
  }
  const res = await fetch(`${API}/auth/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: pending.verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new Error(`OpenRouter didn't accept the sign-in (${res.status}). Tap "Connect" to try again.`);
  const { key } = await res.json();
  if (!key) throw new Error('OpenRouter sent back no key. Tap "Connect" to try again.');
  return key;
}

/** Credit left on the key (null limit = draws from the account balance). */
export async function keyInfo(key) {
  const res = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw Object.assign(new Error(`OpenRouter ${res.status}`), { status: res.status });
  const { data } = await res.json();
  return { usage: data.usage, limit: data.limit, remaining: data.limit_remaining };
}

export async function accountCredits(key) {
  try {
    const res = await fetch(`${API}/credits`, { headers: { Authorization: `Bearer ${key}` } });
    if (!res.ok) return null;
    const { data } = await res.json();
    return data.total_credits - data.total_usage;
  } catch {
    return null;
  }
}

function client(settings) {
  if (!settings.openrouterKey) throw new Error('Connect OpenRouter in Settings first.');
  return new OpenAI({
    apiKey: settings.openrouterKey,
    baseURL: API,
    dangerouslyAllowBrowser: true,
    // Attribution: shows "Aristotle" on the user's OpenRouter activity page
    defaultHeaders: { 'HTTP-Referer': location.origin + location.pathname, 'X-Title': 'Aristotle' },
  });
}

/** Same message shape as the OpenAI path: system prompt, card images + text, then the chat. */
export async function streamOpenRouter({ settings, system, context, history, onText, signal }) {
  const messages = [
    { role: 'system', content: system },
    ...history.map((m, i) => ({
      role: m.role,
      content:
        i === 0
          ? [
              ...context.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mediaType};base64,${img.data}` } })),
              { type: 'text', text: context.text + '\n\n' + m.text },
            ]
          : m.text,
    })),
  ];
  const stream = await client(settings).chat.completions.create(
    { model: settings.openrouterModel || OPENROUTER_MODELS[0][0], messages, stream: true },
    { signal },
  );
  let text = '';
  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      text += delta;
      onText(text);
    }
  }
  return text;
}

/** Recorded audio → 16 kHz mono WAV, a format every transcription model accepts. */
async function toWav(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const decoded = await ac.decodeAudioData(await blob.arrayBuffer());
  ac.close();
  const rate = 16000;
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const pcm = (await offline.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVEfmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, rate, true);
  out.setUint32(28, rate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Uint8Array(out.buffer);
}

export async function transcribeOpenRouter(blob, settings) {
  const wav = await toWav(blob);
  let bin = '';
  for (let i = 0; i < wav.length; i += 0x8000) bin += String.fromCharCode(...wav.subarray(i, i + 0x8000));
  const res = await fetch(`${API}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.openrouterKey}`, 'Content-Type': 'application/json', 'X-Title': 'Aristotle' },
    body: JSON.stringify({
      model: 'openai/gpt-4o-mini-transcribe',
      input_audio: { data: btoa(bin), format: 'wav' },
      ...(settings.voiceLang ? { language: settings.voiceLang.slice(0, 2) } : {}),
    }),
  });
  if (!res.ok) {
    let msg = `Transcription failed (${res.status})`;
    try {
      msg = (await res.json()).error?.message || msg;
    } catch {}
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return (await res.json()).text || '';
}
