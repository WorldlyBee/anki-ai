import { transcribeWithWhisper } from './ai.js';

const SR = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);
export const browserSpeechSupported = !!SR;

/**
 * One dictation session. Calls:
 *   onText(text)   – live transcript while you talk
 *   onDone(text)   – final text, when you stop or go quiet for `autoSendSeconds`
 *   onState(state) – 'listening' | 'transcribing' | 'idle'
 *   onError(msg)
 */
export function createDictation(settings, { onText, onDone, onState, onError }) {
  if (settings.voiceEngine === 'whisper') return whisperDictation(settings, { onText, onDone, onState, onError });
  return browserDictation(settings, { onText, onDone, onState, onError });
}

function browserDictation(settings, { onText, onDone, onState, onError }) {
  if (!SR) {
    return {
      start() {
        onError("This browser has no built-in speech recognition. Use Chrome, or switch to Whisper in Settings.");
      },
      stop() {},
      cancel() {},
    };
  }
  let active = false;
  let finals = '';
  let interim = '';
  let silenceTimer = null;
  let rec = null;
  const current = () => (finals + ' ' + interim).replace(/\s+/g, ' ').trim();

  const armSilenceTimer = () => {
    clearTimeout(silenceTimer);
    const secs = Number(settings.autoSendSeconds);
    if (secs > 0 && current()) silenceTimer = setTimeout(() => finish(true), secs * 1000);
  };

  // Android's recogniser ends itself after every pause, so we run short sessions back to back
  // and stitch the results together until you're actually done.
  const startSegment = () => {
    rec = new SR();
    rec.lang = settings.voiceLang || navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finals += ' ' + r[0].transcript;
        else interim += r[0].transcript;
      }
      onText(current());
      armSilenceTimer();
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        active = false;
        onError('Microphone permission was blocked. Allow it in your browser settings and try again.');
        onState('idle');
      } else if (e.error === 'network') {
        active = false;
        onError("Speech recognition needs an internet connection.");
        onState('idle');
      }
    };
    rec.onend = () => {
      if (interim) {
        finals += ' ' + interim;
        interim = '';
      }
      if (active) {
        try {
          startSegment();
        } catch {
          setTimeout(() => active && startSegment(), 250);
        }
      }
    };
    rec.start();
  };

  const finish = (send) => {
    if (!active) return;
    active = false;
    clearTimeout(silenceTimer);
    try {
      rec?.abort();
    } catch {}
    onState('idle');
    const text = current();
    if (send && text) onDone(text);
  };

  return {
    start() {
      finals = '';
      interim = '';
      active = true;
      onState('listening');
      try {
        startSegment();
      } catch (err) {
        active = false;
        onError(String(err.message || err));
        onState('idle');
      }
    },
    stop: () => finish(true),
    cancel: () => finish(false),
  };
}

function whisperDictation(settings, { onText, onDone, onState, onError }) {
  let recorder, stream, audioCtx, raf, chunks = [];
  let cancelled = false;

  const cleanup = () => {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    audioCtx?.close().catch(() => {});
  };

  return {
    async start() {
      cancelled = false;
      chunks = [];
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        onError('Microphone permission was blocked. Allow it in your browser settings and try again.');
        return;
      }
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        cleanup();
        if (cancelled) return onState('idle');
        onState('transcribing');
        onText('Transcribing…');
        try {
          const text = (await transcribeWithWhisper(new Blob(chunks, { type: recorder.mimeType }), settings)).trim();
          onState('idle');
          if (text) onDone(text);
          else onText('');
        } catch (err) {
          onState('idle');
          onError(err.message || String(err));
        }
      };
      recorder.start();
      onState('listening');
      onText('Listening…');

      // Simple voice-activity detection for auto-send on silence
      audioCtx = new AudioContext();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let heardSpeech = false;
      let lastLoud = performance.now();
      const secs = Number(settings.autoSendSeconds);
      const tick = () => {
        analyser.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);
        if (rms > 0.02) {
          heardSpeech = true;
          lastLoud = performance.now();
          onText('Listening… 🎙️');
        }
        if (secs > 0 && heardSpeech && performance.now() - lastLoud > secs * 1000) {
          if (recorder.state === 'recording') recorder.stop();
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      tick();
    },
    stop() {
      if (recorder?.state === 'recording') recorder.stop();
    },
    cancel() {
      cancelled = true;
      if (recorder?.state === 'recording') recorder.stop();
      else cleanup();
    },
  };
}

// ---------- read aloud ----------

export function speak(text, lang) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[*_#`>$]/g, ''));
  if (lang) u.lang = lang;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}
