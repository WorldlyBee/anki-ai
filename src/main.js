import 'katex/dist/katex.min.css';
import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { startRouter } from './router.js';
import { renderDecks } from './ui/decks.js';
import { renderStudy } from './ui/study.js';
import { renderSettings } from './ui/settings.js';
import { getSettings } from './store.js';
import { requestPersistence } from './db.js';
import { applyTheme } from './theme.js';
import { h, toast } from './ui/dom.js';
import { startAutoSync, enableSync, parsePairing } from './sync/sync.js';
import { navigate } from './router.js';

const app = document.getElementById('app');

async function render(page, arg) {
  try {
    if (page === 'pair') return await pairDevice(arg);
    if (page === 'study') await renderStudy(app, Number(arg));
    else if (page === 'settings') await renderSettings(app);
    else await renderDecks(app);
  } catch (err) {
    console.error(err);
    app.replaceChildren(
      h('header', { class: 'topbar' }, h('h1', {}, 'Something went wrong')),
      h('div', { class: 'empty' }, h('p', {}, String(err?.message || err)), h('a', { href: '#/' }, 'Back to decks')),
    );
  }
}

// Opened from a "Link another device" QR code or link
async function pairDevice(payload) {
  history.replaceState(null, '', location.pathname + '#/'); // keep the token out of browser history
  app.replaceChildren(
    h('header', { class: 'topbar' }, h('h1', {}, 'Linking device')),
    h('div', { class: 'progress' }, h('div', { class: 'spinner' }), h('p', { id: 'pair-status' }, 'Connecting to your sync repo…')),
  );
  try {
    await enableSync(parsePairing(payload), (m) => {
      const el = document.getElementById('pair-status');
      if (el) el.textContent = m;
    });
    toast('This device is linked. Your cards are here.', 4000);
  } catch (err) {
    toast("Couldn't link this device: " + err.message, 6000);
  }
  navigate('#/');
}

(async () => {
  applyTheme((await getSettings()).theme);
  requestPersistence();
  startRouter(render);
  registerSW({ immediate: true });
  startAutoSync();
})();
