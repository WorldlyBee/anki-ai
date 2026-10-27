import { buildCardContext, streamReply } from '../ai.js';
import { createDictation, speak, stopSpeaking } from '../voice.js';
import { getSettings } from '../store.js';
import { h, icon, icons, toast } from './dom.js';
import { renderMarkdown } from './markdown.js';

/**
 * The "ask about this card" sheet. One conversation per card; it resets when the card changes.
 * `getCard()` returns { notetype, note, card, deckName, revealed } for the card on screen.
 */
export class ChatSheet {
  constructor(parent, getCard, onChange = () => {}) {
    this.getCard = getCard;
    this.onChange = onChange;
    this.cardId = null;
    this.history = [];
    this.context = null;
    this.toldRevealed = false;
    this.abort = null;
    this.dictation = null;
    this.listening = false;

    this.messages = h('div', { class: 'messages', 'aria-live': 'polite' });
    this.input = h('textarea', {
      rows: 1, placeholder: 'Ask about this card…', 'aria-label': 'Message',
      oninput: () => this.autosize(),
      // Can't talk out loud? Tap the box while it's listening and type instead
      onfocus: () => this.switchToTyping(),
      onkeydown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendTyped();
        }
      },
    });
    this.micBtn = h('button', { class: 'round primary', 'aria-label': 'Speak', html: icons.mic, onclick: () => this.toggleListening() });
    this.sendBtn = h('button', { class: 'round', 'aria-label': 'Send', html: icons.send, onclick: () => this.sendTyped() });
    this.hint = h('div', { class: 'listen-hint', hidden: true });
    this.expandBtn = h('button', { class: 'icon-btn', 'aria-label': 'Full screen', html: icons.chevron, style: { transform: 'rotate(-90deg)' }, onclick: () => this.setFull(true) });
    this.minBtn = h('button', { class: 'icon-btn', 'aria-label': 'Minimise', html: icons.down, onclick: () => this.close() });
    this.backBtn = h('button', { class: 'back-to-card', hidden: true, onclick: () => this.close() }, icon('down'), 'Back to card');
    this.head = h('div', { class: 'sheet-head' },
      h('div', { class: 'grip' }),
      h('h3', {}, 'Ask Aristotle'),
      this.expandBtn,
      this.minBtn,
      this.backBtn,
    );
    this.el = h('section', { class: 'sheet', 'aria-label': 'Ask Aristotle' },
      this.head,
      this.messages,
      this.hint,
      h('div', { class: 'composer' }, this.input, this.micBtn, this.sendBtn),
    );
    parent.append(this.el);
    this.setupGestures();
    this.onPop = () => this.isOpen && this.close({ fromBack: true });
    window.addEventListener('popstate', this.onPop);
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }
  get isFull() {
    return this.el.classList.contains('full');
  }
  get hasConversation() {
    return this.history.length > 0;
  }

  destroy() {
    window.removeEventListener('popstate', this.onPop);
    this.close({ fromBack: true });
  }

  /** Called whenever a new card is shown. */
  setCard(cardId) {
    if (cardId === this.cardId) return;
    this.cancelListening();
    this.abort?.abort();
    stopSpeaking();
    this.cardId = cardId;
    this.history = [];
    this.context = null;
    this.toldRevealed = false;
    this.messages.replaceChildren();
    this.onChange();
  }

  open({ listen = false } = {}) {
    if (!navigator.onLine) {
      toast("You're offline. Aristotle needs an internet connection to answer.", 3500);
      return;
    }
    if (!this.isOpen) {
      // An extra history entry so the phone's back gesture closes the sheet instead of leaving the deck
      history.pushState({ ...(history.state || {}), aristotleSheet: true }, '');
      this.pushedHistory = true;
    }
    this.el.classList.add('open');
    if (listen) this.startListening();
    else if (!this.history.length) this.input.focus();
  }

  close({ fromBack = false } = {}) {
    const wasOpen = this.isOpen;
    this.cancelListening();
    this.setFull(false);
    this.el.classList.remove('open');
    this.onChange();
    if (wasOpen && this.pushedHistory && !fromBack) history.back();
    this.pushedHistory = false;
  }

  /** Full screen for a longer conversation; half height for a quick question. */
  setFull(on) {
    this.el.classList.toggle('full', on);
    this.expandBtn.hidden = on;
    this.minBtn.hidden = on;
    this.backBtn.hidden = !on;
  }

  /**
   * Drag the header to resize: up for full screen, down to shrink or close; a tap on it toggles.
   * Swiping up in the messages also goes full screen, and pulling down from the top shrinks it again.
   */
  setupGestures() {
    let drag = null;
    this.head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      drag = { y: e.clientY, height: this.el.offsetHeight, max: this.el.parentElement.clientHeight, moved: false };
      this.head.setPointerCapture(e.pointerId);
    });
    this.head.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dy) < 8) return;
      drag.moved = true;
      this.el.style.transition = 'none';
      this.el.style.height = `${Math.min(drag.max, Math.max(120, drag.height - dy))}px`;
    });
    const end = (e) => {
      if (!drag) return;
      const { y, height, max, moved } = drag;
      drag = null;
      const dy = e.clientY - y;
      this.el.style.transition = '';
      this.el.style.height = '';
      if (!moved) return this.setFull(!this.isFull);
      if (dy < -40) this.setFull(true);
      else if (dy > 40) {
        if (this.isFull && height - dy > max * 0.4) this.setFull(false);
        else this.close();
      }
    };
    this.head.addEventListener('pointerup', end);
    this.head.addEventListener('pointercancel', end);

    let swipe = null;
    this.messages.addEventListener('touchstart', (e) => {
      const t = e.touches[0];
      swipe = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, atTop: this.messages.scrollTop <= 0 } : null;
    }, { passive: true });
    this.messages.addEventListener('touchmove', (e) => {
      if (!swipe) return;
      const t = e.touches[0];
      const dx = t.clientX - swipe.x;
      const dy = t.clientY - swipe.y;
      if (Math.abs(dx) > Math.abs(dy)) return;
      if (!this.isFull && dy < -50) {
        this.setFull(true);
        swipe = null;
      } else if (this.isFull && swipe.atTop && dy > 80) {
        this.setFull(false);
        swipe = null;
      }
    }, { passive: true });
  }

  /** Errors before any conversation: say it briefly and get out of the way. */
  fail(msg) {
    if (this.history.length) return this.showError(msg);
    toast(msg, 4000);
    this.close();
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = Math.min(this.input.scrollHeight, 120) + 'px';
  }

  sendTyped() {
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.autosize();
    this.ask(text);
  }

  // ---------- voice ----------

  async toggleListening() {
    if (this.listening) this.dictation?.stop();
    else this.startListening();
  }

  async startListening() {
    if (this.listening) return;
    stopSpeaking();
    const settings = await getSettings();
    // Show the listening bubble straight away so it's obvious the mic is on
    let bubble = h('div', { class: 'msg user pending' }, 'Listening…');
    this.messages.append(bubble);
    this.scrollDown();
    const isPlaceholder = (b) => !b.textContent.trim() || /^(Listening…|Transcribing…)/.test(b.textContent);
    this.dictation = createDictation(settings, {
      onText: (text) => {
        if (!bubble) {
          bubble = h('div', { class: 'msg user pending' });
          this.messages.append(bubble);
        }
        bubble.textContent = text || 'Listening…';
        this.scrollDown();
      },
      onDone: (text) => {
        bubble?.remove();
        bubble = null;
        this.ask(text);
      },
      onState: (state) => {
        this.listening = state === 'listening';
        this.micBtn.className = `round ${this.listening ? 'listening' : 'primary'}`;
        this.micBtn.innerHTML = this.listening ? icons.send : icons.mic;
        this.micBtn.setAttribute('aria-label', this.listening ? 'Send now' : 'Speak');
        this.input.placeholder = this.listening ? 'Listening… or tap here to type' : 'Ask about this card…';
        this.hint.hidden = state === 'idle';
        this.hint.textContent =
          state === 'transcribing'
            ? 'Transcribing…'
            : Number(settings.autoSendSeconds) > 0
              ? `Listening. Sends when you pause for ${settings.autoSendSeconds}s, or tap send.`
              : 'Listening. Tap send when you are done.';
        if (state === 'idle' && bubble && isPlaceholder(bubble)) {
          bubble.remove();
          bubble = null;
        }
      },
      onError: (msg) => {
        bubble?.remove();
        bubble = null;
        this.fail(msg);
      },
    });
    this.dictation.start();
  }

  /** Stops listening so you can type; anything already heard moves into the box to finish or fix. */
  switchToTyping() {
    if (!this.listening) return;
    const heard = [...this.messages.querySelectorAll('.msg.pending')]
      .map((b) => b.textContent.trim())
      .find((t) => t && !/^(Listening…|Transcribing…)/.test(t));
    this.cancelListening();
    this.input.placeholder = 'Ask about this card…';
    if (heard) {
      this.input.value = [this.input.value.trim(), heard].filter(Boolean).join(' ');
      this.autosize();
      this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    }
  }

  cancelListening() {
    if (this.dictation) this.dictation.cancel();
    this.messages.querySelectorAll('.msg.pending').forEach((b) => b.remove());
    this.listening = false;
  }

  // ---------- conversation ----------

  async ask(text) {
    const settings = await getSettings();
    const info = this.getCard();
    if (!info) return;
    if (!this.context) {
      this.context = await buildCardContext({ ...info, settings });
      this.toldRevealed = info.revealed;
    } else if (info.revealed && !this.toldRevealed) {
      text = "(I've flipped the card now.) " + text;
      this.toldRevealed = true;
    }
    this.history.push({ role: 'user', text });
    this.messages.append(h('div', { class: 'msg user' }, text.replace(/^\(I've flipped the card now\.\) /, '')));
    this.onChange();

    const bubble = h('div', { class: 'msg ai typing' });
    this.messages.append(bubble);
    this.scrollDown();

    this.abort?.abort();
    const controller = (this.abort = new AbortController());
    let frame = 0;
    let latest = '';
    const paint = () => {
      frame = 0;
      bubble.innerHTML = renderMarkdown(latest);
      this.scrollDown();
    };
    this.sendBtn.innerHTML = icons.stop;
    this.sendBtn.onclick = () => controller.abort();
    try {
      const reply = await streamReply({
        settings,
        context: this.context,
        history: this.history,
        signal: controller.signal,
        onText: (t) => {
          latest = t;
          if (!frame) frame = requestAnimationFrame(paint);
        },
      });
      latest = reply;
      cancelAnimationFrame(frame); // a queued repaint would wipe the buttons added below
      paint();
      bubble.classList.remove('typing');
      this.history.push({ role: 'assistant', text: reply });
      bubble.append(this.tools(reply, settings));
      if (settings.autoSpeak) speak(reply, settings.voiceLang);
    } catch (err) {
      cancelAnimationFrame(frame);
      bubble.classList.remove('typing');
      if (controller.signal.aborted) {
        if (latest) this.history.push({ role: 'assistant', text: latest });
        else {
          bubble.remove();
          this.history.pop();
        }
      } else {
        bubble.remove();
        this.history.pop(); // let them retry the same question
        this.messages.lastElementChild?.classList.contains('user') && !this.history.length && this.messages.lastElementChild.remove();
        this.fail(friendlyError(err));
      }
    } finally {
      this.sendBtn.innerHTML = icons.send;
      this.sendBtn.onclick = () => this.sendTyped();
      this.onChange();
    }
  }

  tools(text, settings) {
    return h('div', { class: 'msg-tools' },
      h('button', { 'aria-label': 'Read aloud', onclick: () => speak(text, settings.voiceLang) }, icon('speaker')),
      h('button', { 'aria-label': 'Copy', onclick: () => navigator.clipboard?.writeText(text) }, h('span', { class: 'icon', html: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z"/></svg>' })),
    );
  }

  showError(msg) {
    this.messages.append(h('div', { class: 'msg error' }, msg));
    this.scrollDown();
  }

  scrollDown() {
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}

function friendlyError(err) {
  const status = err?.status;
  if (status === 401) return 'Your API key was rejected. Check it in Settings.';
  if (status === 402) return "You're out of AI credit. Add more in Settings → AI tutor → Add credit.";
  if (status === 404) return "That model name wasn't found. Pick another one in Settings.";
  if (status === 429) return "Rate limited or out of credit. Wait a moment, or check your API account's billing.";
  if (status === 529 || status === 503) return 'The AI service is overloaded right now. Try again in a moment.';
  if (status >= 500) return 'The AI service had a hiccup. Try again in a moment.';
  if (status === 400) return "The AI couldn't handle that request. Try rephrasing, or pick another model in Settings.";
  if (!navigator.onLine) return "You're offline. The AI needs an internet connection.";
  return err?.message || String(err);
}
