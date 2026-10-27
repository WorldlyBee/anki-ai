import { h, icons } from './dom.js';

/**
 * Full-screen picture viewer: pinch or wheel to zoom, drag to pan, double-tap to zoom in/out,
 * and the ✕, a tap on the backdrop, Escape or the phone's back gesture to close.
 */
export function openLightbox(src, alt = '') {
  const img = h('img', { src, alt, draggable: 'false' });
  const stage = h('div', { class: 'lightbox-stage' }, img);
  const closeBtn = h('button', { class: 'lightbox-close', 'aria-label': 'Close picture', html: icons.close });
  const box = h('div', { class: 'lightbox', role: 'dialog', 'aria-label': alt || 'Picture' }, stage, closeBtn);
  document.body.append(box);
  // Fit the picture to the screen, enlarging small ones (card images are often thumbnails)
  const fit = () => {
    if (!img.naturalWidth) return;
    const k = Math.min((innerWidth - 24) / img.naturalWidth, (innerHeight - 96) / img.naturalHeight);
    img.style.width = `${Math.round(img.naturalWidth * k)}px`;
    img.style.height = `${Math.round(img.naturalHeight * k)}px`;
  };
  if (img.complete) fit();
  else img.addEventListener('load', fit, { once: true });

  let scale = 1;
  let x = 0;
  let y = 0;
  const apply = (animate = false) => {
    img.style.transition = animate ? 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)' : 'none';
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  // Keep the picture from being dragged entirely off screen
  const clamp = () => {
    const r = img.getBoundingClientRect();
    const w = r.width / scale;
    const hgt = r.height / scale;
    const maxX = Math.max(0, (w * scale - innerWidth) / 2);
    const maxY = Math.max(0, (hgt * scale - innerHeight) / 2);
    x = Math.min(maxX, Math.max(-maxX, x));
    y = Math.min(maxY, Math.max(-maxY, y));
  };
  /** Zoom to `next`, keeping the screen point (cx, cy) under the finger. */
  const zoomAt = (next, cx, cy, animate) => {
    next = Math.min(6, Math.max(1, next));
    const ox = cx - innerWidth / 2;
    const oy = cy - innerHeight / 2;
    x = ox - ((ox - x) * next) / scale;
    y = oy - ((oy - y) * next) / scale;
    scale = next;
    if (scale === 1) x = y = 0;
    clamp();
    apply(animate);
  };

  const pointers = new Map();
  let pinch = null;
  let pan = null;
  let lastTap = 0;
  let moved = false;
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale };
      pan = null;
    } else {
      pan = { x: e.clientX, y: e.clientY, startX: x, startY: y };
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      moved = true;
      zoomAt((pinch.scale * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
    } else if (pan) {
      const dx = e.clientX - pan.x;
      const dy = e.clientY - pan.y;
      if (Math.hypot(dx, dy) > 6) moved = true;
      if (scale > 1) {
        x = pan.startX + dx;
        y = pan.startY + dy;
        clamp();
        apply();
      }
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size) return;
    pan = null;
    if (moved) return;
    // A tap: double-tap toggles zoom; a single tap outside the picture closes
    const now = Date.now();
    if (now - lastTap < 320) {
      lastTap = 0;
      zoomAt(scale > 1.05 ? 1 : 2.5, e.clientX, e.clientY, true);
    } else {
      lastTap = now;
      const onPicture = e.target === img;
      setTimeout(() => {
        if (lastTap === now && !onPicture && scale === 1) close();
      }, 330);
    }
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  }, { passive: false });

  // Back gesture closes the viewer instead of leaving the deck
  history.pushState({ ...(history.state || {}), aristotleLightbox: true }, '');
  let closed = false;
  const onPop = () => close(true);
  const onKey = (e) => e.key === 'Escape' && close();
  window.addEventListener('popstate', onPop);
  document.addEventListener('keydown', onKey);
  function close(fromBack = false) {
    if (closed) return;
    closed = true;
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('keydown', onKey);
    box.classList.add('closing');
    setTimeout(() => box.remove(), 180);
    if (!fromBack) history.back();
  }
  closeBtn.addEventListener('click', () => close());
  requestAnimationFrame(() => box.classList.add('open'));
}

/** Calls `fn(img)` on a double-tap or double-click of any picture inside `root`. */
export function onImageDoubleTap(root, fn) {
  let last = { t: 0, img: null };
  const hit = (img) => {
    last = { t: 0, img: null };
    fn(img);
  };
  root.addEventListener('dblclick', (e) => {
    if (e.target.tagName === 'IMG') {
      e.preventDefault();
      if (last.img !== 'done') hit(e.target);
    }
  });
  // Phones don't always send dblclick, so time the taps ourselves too
  root.addEventListener('pointerup', (e) => {
    if (e.target.tagName !== 'IMG' || e.pointerType === 'mouse') return;
    const now = Date.now();
    if (last.img === e.target && now - last.t < 320) {
      hit(e.target);
      last = { t: now, img: 'done' }; // ignore the dblclick that may follow
      setTimeout(() => last.img === 'done' && (last = { t: 0, img: null }), 400);
    } else last = { t: now, img: e.target };
  });
}
