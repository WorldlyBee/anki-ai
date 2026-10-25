// Tiny helpers so the screens can stay plain JS.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

let toastTimer;
export function toast(msg, ms = 2500) {
  let el = $('#toast');
  if (!el) document.body.append((el = h('div', { id: 'toast', role: 'status' })));
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

/**
 * A bottom-sheet style dialog. Resolves with the clicked button's value (or null if dismissed).
 * `body` may be a function receiving `close(value)`, for content that ends the dialog itself.
 */
export function dialog({ title, body, buttons = [{ label: 'OK', value: true, primary: true }] }) {
  return new Promise((resolve) => {
    const close = (v) => {
      overlay.remove();
      resolve(v);
    };
    const overlay = h(
      'div',
      { class: 'overlay', onclick: (e) => e.target === overlay && close(null) },
      h(
        'div',
        { class: 'dialog', role: 'dialog', 'aria-label': title },
        title && h('h2', {}, title),
        typeof body === 'function' ? body(close) : body,
        h(
          'div',
          { class: 'dialog-buttons' },
          buttons.map((b) =>
            h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: () => close(typeof b.value === 'function' ? b.value() : b.value) }, b.label),
          ),
        ),
      ),
    );
    document.body.append(overlay);
    overlay.querySelector('input, select')?.focus();
  });
}

export function menu(anchor, items) {
  document.querySelector('.popup-menu')?.remove();
  const rect = anchor.getBoundingClientRect();
  const el = h(
    'div',
    { class: 'popup-menu', style: { top: `${rect.bottom + 4}px`, right: `${Math.max(8, window.innerWidth - rect.right)}px` } },
    items.filter(Boolean).map((it) =>
      h('button', { disabled: it.disabled, onclick: () => (el.remove(), it.action()) }, it.label),
    ),
  );
  document.body.append(el);
  setTimeout(() => document.addEventListener('click', function off(e) {
    if (!el.contains(e.target)) {
      el.remove();
      document.removeEventListener('click', off);
    }
  }), 0);
}

export const icons = {
  back: '<svg viewBox="0 0 24 24"><path d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11z"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.3 7.3 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.3 7.3 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.3 7.3 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.3 7.3 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M10 6 8.6 7.4l4.6 4.6-4.6 4.6L10 18l6-6z"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 4h16v12H5.2L4 17.2V4zm0-2a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2z"/></svg>',
};

export const icon = (name, cls = '') => h('span', { class: `icon ${cls}`, html: icons[name], 'aria-hidden': 'true' });
