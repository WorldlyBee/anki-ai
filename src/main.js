import 'katex/dist/katex.min.css';
import '@fontsource/source-sans-3/400.css';
import '@fontsource/source-sans-3/600.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/cormorant-garamond/500-italic.css';
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
import { finishOpenRouterConnect } from './openrouter.js';
import { saveSettings } from './store.js';
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
  // Back from "Connect OpenRouter"?
  try {
    const key = await finishOpenRouterConnect();
    if (key) {
      await saveSettings({ openrouterKey: key, provider: 'openrouter' });
      location.hash = '#/settings';
      setTimeout(() => toast('OpenRouter connected. Aristotle is ready to tutor you.', 4000), 300);
    }
  } catch (err) {
    location.hash = '#/settings';
    setTimeout(() => toast(err.message, 6000), 300);
  }
  startRouter(render);
  registerSW({ immediate: true });
  startAutoSync();
})();
