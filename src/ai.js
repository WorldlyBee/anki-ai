import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { mediaBlob } from './store.js';
import { cardAsText, imageNames } from './render.js';

const SYSTEM = `You are a friendly, sharp tutor helping a student who is reviewing flashcards (Anki-style spaced repetition).
Each conversation is about one flashcard, shown to you first. The student talks to you through speech-to-text, so expect the odd garbled or misheard word and interpret it charitably.
Explain things clearly and conversationally. Start with the direct answer, then add the intuition, mechanism or a memorable hook that makes it stick. Keep replies short enough to read on a phone (usually under ~200 words) unless the student asks you to go deeper.
If the student hasn't flipped the card yet, don't reveal the answer unless they ask for it; give hints instead.
Use light Markdown (short paragraphs, bullets, bold for key terms). For math, use $...$ inline or $$...$$ for display.`;

// Models that accept Anthropic's server-side refusal fallback
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

/** Scales an image down and returns base64 JPEG/PNG so it stays well under API size limits. */
async function encodeImage(blob, maxSide = 1280) {
  if (!/^image\/(png|jpeg|gif|webp|bmp|avif)/.test(blob.type)) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    const buf = new Uint8Array(await out.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { mediaType: 'image/jpeg', data: btoa(bin) };
  } catch {
    return null;
  }
}

/** Builds the opening context for a card: its text plus up to 4 images. */
export async function buildCardContext({ notetype, note, card, deckName, revealed, settings }) {
  const { front, back } = cardAsText({ notetype, note, card, deckName });
  const text =
    `Here's the flashcard I'm studying (deck: ${deckName || 'unknown'}).\n\n` +
    `FRONT:\n${front || '(empty)'}\n\nBACK:\n${back || '(empty)'}\n\n` +
    (revealed ? "(I've already seen the back of the card.)" : "(I haven't flipped the card yet.)");
  const images = [];
  if (settings.sendImages) {
    for (const name of imageNames(note).slice(0, 4)) {
      const blob = await mediaBlob(name);
      const img = blob && (await encodeImage(blob));
      if (img) images.push(img);
    }
  }
  return { text, images };
}

/**
 * Streams a reply. `history` is [{role:'user'|'assistant', text}] where the first user turn
 * carries the card context. Calls onText(fullTextSoFar) as tokens arrive.
 */
export async function streamReply({ settings, context, history, onText, signal }) {
  if (settings.provider === 'openai') return streamOpenAI({ settings, context, history, onText, signal });
  return streamAnthropic({ settings, context, history, onText, signal });
}

async function streamAnthropic({ settings, context, history, onText, signal }) {
  if (!settings.anthropicKey) throw new Error('Add your Anthropic API key in Settings first.');
  const client = new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
  const messages = history.map((m, i) => ({
    role: m.role,
    content:
      i === 0
        ? [
            ...context.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } })),
            { type: 'text', text: context.text + '\n\n' + m.text },
          ]
        : m.text,
  }));
  const model = settings.anthropicModel;
  const params = {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    messages,
    thinking: { type: 'adaptive' },
    output_config: { effort: settings.effort || 'low' },
  };
  if (FALLBACK_MODELS.includes(model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  const stream = client.beta.messages.stream(params, { signal });
  let text = '';
  stream.on('text', (delta) => {
    text += delta;
    onText(text);
  });
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    text += (text ? '\n\n' : '') + "_The model declined to answer this one. Try rephrasing, or switch models in Settings._";
    onText(text);
  }
  return text;
}

async function streamOpenAI({ settings, context, history, onText, signal }) {
  if (!settings.openaiKey) throw new Error('Add your OpenAI API key in Settings first.');
  const client = new OpenAI({ apiKey: settings.openaiKey, dangerouslyAllowBrowser: true });
  const messages = [
    { role: 'system', content: SYSTEM },
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
  const stream = await client.chat.completions.create({ model: settings.openaiModel, messages, stream: true }, { signal });
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

export async function transcribeWithWhisper(blob, settings) {
  if (!settings.openaiKey) throw new Error('Whisper dictation needs an OpenAI API key in Settings.');
  const client = new OpenAI({ apiKey: settings.openaiKey, dangerouslyAllowBrowser: true });
  const ext = blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogg' : 'webm';
  const res = await client.audio.transcriptions.create({
    file: new File([blob], `speech.${ext}`, { type: blob.type }),
    model: settings.whisperModel || 'gpt-4o-mini-transcribe',
    ...(settings.voiceLang ? { language: settings.voiceLang.slice(0, 2) } : {}),
  });
  return res.text;
}

export async function listModels(settings) {
  if (settings.provider === 'openai') {
    const client = new OpenAI({ apiKey: settings.openaiKey, dangerouslyAllowBrowser: true });
    const out = [];
    for await (const m of client.models.list()) if (/^(gpt|o\d|chatgpt)/.test(m.id) && !/audio|realtime|tts|transcribe|image|search/.test(m.id)) out.push(m.id);
    return out.sort();
  }
  const client = new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
  const out = [];
  for await (const m of client.models.list()) out.push(m.id);
  return out;
}
