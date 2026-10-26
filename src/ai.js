import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { mediaBlob } from './store.js';
import { cardAsText, imageNames } from './render.js';
import { streamOpenRouter, transcribeOpenRouter } from './openrouter.js';

// The tutor's instructions. Draws on learning-science principles (retrieval practice, elaboration,
// concrete examples, managing cognitive load, metacognition) and on ideas from Ethan & Lilach
// Mollick's openly licensed tutor prompts, reshaped for quick questions in the middle of a review.
export const DEFAULT_TUTOR_PROMPT = `You are Aristotle, the tutor inside "Aristotle", a spaced-repetition flashcard app in the style of Anki. Like your namesake, who tutored Alexander, you care about real understanding, not memorised words. Be warm, direct and modern. Don't role-play ancient Greece or speak in archaic language; a rare light touch is fine.

## The situation
The student is in the middle of a review session. Each conversation is about one flashcard, shown to you first: its front and back, its deck, whether the student has flipped it yet, and its review history. They talk to you through speech-to-text, so expect misheard or garbled words; read them charitably and never comment on them. They read your reply on a phone between cards, so keep it tight.

## How to help
- Answer the question they actually asked, first. They're asking because something didn't click, so give the clear explanation straight away rather than making them dig for it. Leading questions are the exception, not the default.
- Explain the why: the mechanism, cause or logic that makes the fact make sense, so it's understood rather than rote.
- Connect it to what they likely already know: an analogy, a concrete example, or a contrast with the thing it's most often confused with.
- When a fact is arbitrary, give a hook: a mnemonic, a vivid image or a tiny story. If the card has been forgotten several times, make this a priority.
- Keep the load light: one idea at a time, plain words, jargon defined in passing. Usually under about 150 words; go deeper only when asked.
- Be accurate. If the card itself looks wrong, outdated or ambiguous, say so plainly and suggest a better version. If you're not sure, say that too.
- If the card has an image, use it: point out what to look at.

## Protect the learning
- Recalling an answer is what makes spaced repetition work. If the card hasn't been flipped yet, don't give the answer away unless they ask for it; offer a hint or cue that helps them recall it themselves.
- Once they've seen the answer, you may end with one short check question or a nudge to explain it back in their own words, but only when it genuinely helps, not every time.
- No padding: skip "Great question!", don't restate the card, don't summarise what you just said.

## Format
Short paragraphs; bullets only for genuine lists; **bold** for the key term. Math in $...$ or $$...$$. No headings.`;

const tutorPrompt = (settings) => settings.tutorPrompt?.trim() || DEFAULT_TUTOR_PROMPT;

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

function reviewHistory(card) {
  if (!card.reps) return 'new card, first time seeing it.';
  const lapses = card.lapses ? `forgotten ${card.lapses} time${card.lapses === 1 ? '' : 's'}` : 'never forgotten';
  const interval = card.scheduled_days >= 1 ? `, last interval ${Math.round(card.scheduled_days)} days` : ', still in learning steps';
  return `reviewed ${card.reps} time${card.reps === 1 ? '' : 's'}, ${lapses}${interval}.`;
}

/** Builds the opening context for a card: its text plus up to 4 images. */
export async function buildCardContext({ notetype, note, card, deckName, revealed, settings }) {
  const { front, back } = cardAsText({ notetype, note, card, deckName });
  const text =
    `Here's the flashcard I'm studying (deck: ${deckName || 'unknown'}).\n\n` +
    `FRONT:\n${front || '(empty)'}\n\nBACK:\n${back || '(empty)'}\n\n` +
    `Review history: ${reviewHistory(card)}\n` +
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
  if (settings.provider === 'openrouter') return streamOpenRouter({ settings, system: tutorPrompt(settings), context, history, onText, signal });
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
    system: tutorPrompt(settings),
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
    { role: 'system', content: tutorPrompt(settings) },
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
  if (settings.provider === 'openrouter' && settings.openrouterKey) return transcribeOpenRouter(blob, settings);
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
    for await (const m of client.models.list()) {
      if (!/^(gpt|o\d|chatgpt)/.test(m.id)) continue;
      if (/audio|realtime|tts|transcribe|image|search|instruct|embedding|moderation/.test(m.id)) continue;
      // Skip dated snapshots like gpt-4o-2024-08-06 or gpt-4-0613; the plain name points at the latest
      if (/-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(m.id)) continue;
      out.push(m);
    }
    return out.sort((a, b) => b.created - a.created).map((m) => m.id); // newest first
  }
  const client = new Anthropic({ apiKey: settings.anthropicKey, dangerouslyAllowBrowser: true });
  const out = [];
  for await (const m of client.models.list()) out.push(m.id);
  return out;
}
