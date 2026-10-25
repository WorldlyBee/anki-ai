import { getSettings, saveSettings } from '../store.js';
import { listModels } from '../ai.js';
import { browserSpeechSupported } from '../voice.js';
import { exportBackup, restoreBackup } from '../backup.js';
import { db, getKV, setKV } from '../db.js';
import { h, icon, toast, dialog } from './dom.js';
import { navigate } from '../router.js';
import { applyTheme } from '../theme.js';
import { syncSection, timeAgo } from './syncSettings.js';
import { getSyncConfig, backupToRepo, listRepoBackups, restoreFromRepo, forgetPulledData, syncNow } from '../sync/sync.js';

const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (smartest, ~2¢ per question)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (great, ~1¢)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (fast & cheapest, <0.1¢)'],
];

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

export async function renderSettings(app) {
  const s = await getSettings();
  const save = async (patch) => {
    await saveSettings(patch);
    if ('theme' in patch) applyTheme(patch.theme);
  };

  const text = (key, label, { type = 'text', hint, placeholder, list } = {}) =>
    h('label', { class: 'field' },
      h('span', {}, label),
      h('input', {
        type, value: s[key] ?? '', placeholder, list, autocomplete: 'off', spellcheck: 'false',
        onchange: (e) => save({ [key]: type === 'number' ? Number(e.target.value) : e.target.value.trim() }),
      }),
      hint && h('small', {}, hint),
    );
  const select = (key, label, options, { hint, onchange } = {}) =>
    h('label', { class: 'field' },
      h('span', {}, label),
      h('select', {
        onchange: async (e) => {
          await save({ [key]: e.target.value });
          onchange?.(e.target.value);
        },
      }, options.map(([v, l]) => h('option', { value: v, selected: s[key] === v }, l))),
      hint && h('small', {}, hint),
    );
  const check = (key, label) =>
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: !!s[key], onchange: (e) => save({ [key]: e.target.checked }) }),
      h('span', {}, label),
    );

  const providerBox = h('div');
  let openaiModels = await getKV('openaiModels', []);
  const paintProvider = () => {
    const isClaude = (s.provider = s.provider || 'anthropic') === 'anthropic';
    const loadBtn = h('button', {
      class: 'btn', type: 'button',
      onclick: async () => {
        try {
          openaiModels = await listModels(await getSettings());
          await setKV('openaiModels', openaiModels);
          toast(`Found ${openaiModels.length} models`);
          paintProvider();
        } catch (err) {
          toast('Could not load models: ' + (err.status === 401 ? 'check your API key' : err.message), 4000);
        }
      },
    }, openaiModels.length ? 'Refresh model list' : 'Load available models');
    providerBox.replaceChildren(
      isClaude
        ? h('div', {},
            text('anthropicKey', 'Anthropic API key', { type: 'password', placeholder: 'sk-ant-…', hint: 'Get one at console.anthropic.com → API keys. Stays on this device.' }),
            select('anthropicModel', 'Model', CLAUDE_MODELS.some(([v]) => v === s.anthropicModel) ? CLAUDE_MODELS : [...CLAUDE_MODELS, [s.anthropicModel, s.anthropicModel]]),
            select('effort', 'Thinking effort', [['low', 'Low (fast, cheapest)'], ['medium', 'Medium'], ['high', 'High (slower, deeper)']], { hint: 'Low is plenty for most flashcard questions.' }),
          )
        : h('div', {},
            text('openaiKey', 'OpenAI API key', { type: 'password', placeholder: 'sk-…', hint: 'Get one at platform.openai.com → API keys. Stays on this device.' }),
            openaiModelPicker(),
            h('div', { class: 'row-btns' }, loadBtn),
          ),
    );
  };
  // A real <select> once the list is loaded: Android Chrome barely supports <datalist> suggestions
  const OTHER = '__other__';
  const openaiModelPicker = () => {
    if (!openaiModels.length) return text('openaiModel', 'Model', { hint: 'Type a model name, or load the list from your account.' });
    const options = openaiModels.includes(s.openaiModel) || !s.openaiModel ? openaiModels : [s.openaiModel, ...openaiModels];
    const custom = h('input', {
      type: 'text', value: s.openaiModel || '', placeholder: 'model name', autocomplete: 'off', spellcheck: 'false', hidden: true,
      onchange: (e) => save({ openaiModel: (s.openaiModel = e.target.value.trim()) }),
    });
    return h('label', { class: 'field' },
      h('span', {}, 'Model'),
      h('select', {
        onchange: async (e) => {
          custom.hidden = e.target.value !== OTHER;
          if (e.target.value === OTHER) return custom.focus();
          await save({ openaiModel: (s.openaiModel = e.target.value) });
        },
      },
        options.map((m) => h('option', { value: m, selected: m === s.openaiModel }, m)),
        h('option', { value: OTHER }, 'Other (type a name)…'),
      ),
      custom,
      h('small', {}, 'Newest first. Smaller "mini" models are faster and cheaper.'),
    );
  };
  paintProvider();

  const installBtn = installPrompt &&
    h('button', { class: 'btn primary', onclick: async () => { installPrompt.prompt(); installPrompt = null; } }, 'Install as app');

  const usage = h('p', { class: 'note' });
  navigator.storage?.estimate?.().then(({ usage: u }) => (usage.textContent = `Using ${(u / 1024 / 1024).toFixed(1)} MB on this device.`));
  const lastBackup = await getKV('lastBackup');
  const syncConfig = await getSyncConfig();

  const restoreInput = h('input', {
    type: 'file', accept: '.zip', style: { display: 'none' },
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const ok = await dialog({
        title: 'Restore this backup?',
        body: h('p', {}, 'Everything currently in the app will be replaced by the backup.'),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Restore', value: true, danger: true }],
      });
      if (!ok) return;
      try {
        await restoreBackup(file, (m) => toast(m, 10000));
        toast('Backup restored');
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        toast('Restore failed: ' + err.message, 5000);
      }
    },
  });

  app.replaceChildren(
    h('header', { class: 'topbar' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back', html: icon('back').outerHTML, onclick: () => navigate('#/') }),
      h('h1', {}, 'Settings'),
    ),
    h('div', { class: 'scroll' }, h('div', { class: 'settings' },
      installBtn && h('div', { class: 'row-btns' }, installBtn),

      h('h2', {}, 'Sync between devices'),
      await syncSection(() => renderSettings(app)),

      h('h2', {}, 'AI tutor'),
      select('provider', 'AI provider', [['anthropic', 'Claude (Anthropic)'], ['openai', 'ChatGPT (OpenAI)']], { onchange: (v) => ((s.provider = v), paintProvider()) }),
      providerBox,
      check('sendImages', 'Send card images to the AI'),

      h('h2', {}, 'Voice'),
      select('voiceEngine', 'Dictation', [
        ['browser', `Built-in speech recognition (free)${browserSpeechSupported ? '' : ' (not available in this browser)'}`],
        ['whisper', 'OpenAI Whisper (more accurate, needs OpenAI key)'],
      ], { hint: "Whisper waits until you've finished talking, so it never cuts you off mid-thought. It works even if you use Claude for answers." }),
      h('div', { class: 'inline' },
        text('autoSendSeconds', 'Auto-send after silence (sec)', { type: 'number', hint: '0 = only send when you tap' }),
        text('voiceLang', 'Language', { placeholder: navigator.language, hint: 'e.g. en-US, fr-FR' }),
      ),
      check('autoSpeak', 'Read answers aloud automatically'),
      s.voiceEngine === 'whisper' && !s.openaiKey && s.provider === 'anthropic' &&
        text('openaiKey', 'OpenAI API key (for Whisper)', { type: 'password', placeholder: 'sk-…' }),

      h('h2', {}, 'Studying'),
      h('div', { class: 'inline' },
        text('newPerDay', 'New cards / day', { type: 'number' }),
        text('revPerDay', 'Max reviews / day', { type: 'number' }),
      ),
      text('retention', 'Desired retention', { type: 'number', hint: 'FSRS target, 0.80–0.97. Higher = more reviews, better recall. 0.9 is a good default.' }),
      h('div', { class: 'inline' },
        text('learningSteps', 'Learning steps', { hint: 'e.g. 1m 10m' }),
        text('relearningSteps', 'Relearning steps', { hint: 'e.g. 10m' }),
      ),
      text('rolloverHour', 'Next day starts at (hour)', { type: 'number', hint: '4 = 4am, like Anki' }),
      select('theme', 'Theme', [['system', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']]),

      h('h2', {}, 'Your data'),
      ...(await dataSection(syncConfig, lastBackup, restoreInput)),
      usage,
      h('div', { class: 'row-btns' },
        h('button', {
          class: 'btn danger',
          onclick: async () => {
            const ok = await dialog({
              title: 'Erase everything?',
              body: h('p', {}, 'All decks, cards, review history and images will be deleted from this device. Your settings and API keys are kept. If sync is on, your cards come back from GitHub on the next sync; turn sync off first if you want this device empty.'),
              buttons: [{ label: 'Cancel', value: false }, { label: 'Erase', value: true, danger: true }],
            });
            if (!ok) return;
            await Promise.all([db.decks.clear(), db.notetypes.clear(), db.notes.clear(), db.cards.clear(), db.reviews.clear(), db.media.clear()]);
            await forgetPulledData();
            toast('All study data erased');
            navigate('#/');
          },
        }, 'Erase all study data'),
      ),
    )),
  );
}

async function downloadBackup() {
  toast('Preparing backup…', 10000);
  const blob = await exportBackup((m) => toast(m, 10000));
  const a = h('a', { href: URL.createObjectURL(blob), download: `aristotle-backup-${new Date().toISOString().slice(0, 10)}.zip` });
  document.body.append(a);
  a.click();
  a.remove();
  await setKV('lastBackup', Date.now());
  toast('Backup saved to your downloads');
}

/** Backup buttons: to the sync repo when sync is on, otherwise to a downloaded file. */
async function dataSection(syncConfig, lastBackup, restoreInput) {
  const last = lastBackup && h('p', { class: 'note' }, `Last backup: ${timeAgo(lastBackup)}`);
  if (!syncConfig) {
    return [
      h('p', { class: 'note' }, 'Everything is stored only on this device. Back up now and then, especially before clearing browser data. (Turn on sync above and backups go to GitHub automatically.)'),
      last,
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn primary', onclick: downloadBackup }, 'Back up'),
        h('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Restore backup'),
        restoreInput,
      ),
    ];
  }
  return [
    h('p', { class: 'note' }, 'Your cards are synced to GitHub. Backups are dated snapshots saved there too, so you can roll back if something goes wrong (say, a deck deleted by accident). One is made automatically every week; the latest 12 are kept.'),
    last,
    h('div', { class: 'row-btns' },
      h('button', {
        class: 'btn primary',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          toast('Backing up to GitHub…', 20000);
          try {
            const r = await backupToRepo();
            toast(`Backed up ${r.cards} cards to GitHub`);
            if (last) last.textContent = 'Last backup: just now';
          } catch (err) {
            toast('Backup failed: ' + err.message, 5000);
          }
          btn.disabled = false;
        },
      }, 'Back up now'),
      h('button', { class: 'btn', onclick: () => pickRepoBackup() }, 'Restore…'),
    ),
    h('details', { class: 'setup' },
      h('summary', {}, 'Backup files'),
      h('p', { class: 'note' }, 'A single .zip with everything, images included, saved to your downloads. Handy for keeping a copy outside GitHub.'),
      h('div', { class: 'row-btns' },
        h('button', { class: 'btn', onclick: downloadBackup }, 'Download a copy'),
        h('button', { class: 'btn', onclick: () => restoreInput.click() }, 'Restore from file'),
        restoreInput,
      ),
    ),
  ];
}

async function pickRepoBackup() {
  toast('Loading backups…', 10000);
  let backups;
  try {
    backups = await listRepoBackups();
  } catch (err) {
    return toast("Couldn't load backups: " + err.message, 5000);
  }
  toast('Backups loaded', 1);
  if (!backups.length) {
    return dialog({ title: 'No backups yet', body: h('p', {}, 'Tap "Back up now" to make the first one.') });
  }
  const choice = await dialog({
    title: 'Restore a backup',
    body: h('div', {},
      h('p', { class: 'note' }, 'This device goes back to how it was at that moment. Anything deleted since comes back on your other devices too.'),
      h('div', { class: 'backup-list' }, backups.map((b, i) =>
        h('label', { class: 'check' },
          h('input', { type: 'radio', name: 'backup', value: b.path, checked: i === 0 }),
          h('span', {}, new Date(b.time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }), i === 0 ? ' (latest)' : ''),
        ),
      )),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Restore', danger: true, value: () => document.querySelector('.dialog input[name=backup]:checked')?.value },
    ],
  });
  if (!choice) return;
  try {
    await restoreFromRepo(choice, (m) => toast(m, 20000));
    toast('Backup restored');
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    toast('Restore failed: ' + err.message, 5000);
  }
}
