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
import { h } from './ui/dom.js';

const app = document.getElementById('app');

async function render(page, arg) {
  try {
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

(async () => {
  applyTheme((await getSettings()).theme);
  requestPersistence();
  startRouter(render);
  registerSW({ immediate: true });
})();
