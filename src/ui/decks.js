import { db, getKV, setKV } from '../db.js';
import { getSettings, importFile, todayLog, deleteDeck } from '../store.js';
import { buildQueues } from '../scheduler.js';
import { exportBackup } from '../backup.js';
import { h, icon, toast, dialog, menu } from './dom.js';
import { navigate, onLeave } from '../router.js';
import { getSyncStatus, onSyncStatus, getSyncConfig, backupToRepo } from '../sync/sync.js';
import { syncStatusText } from './syncSettings.js';

export async function renderDecks(app) {
  const settings = await getSettings();
  const [decks, cards, log] = await Promise.all([db.decks.toArray(), db.cards.toArray(), todayLog(settings)]);
  const collapsed = new Set(await getKV('collapsed', []));

  decks.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }));
  // Hide decks with no cards anywhere beneath them (e.g. an empty "Default")
  const hasCards = new Set(cards.map((c) => c.did));
  const visible = decks.filter((d) => decks.some((x) => (x.id === d.id || x.name.startsWith(d.name + '::')) && hasCards.has(x.id)));

  const fileInput = h('input', {
    type: 'file', accept: '.apkg,.colpkg,.zip', style: { display: 'none' },
    onchange: (e) => e.target.files[0] && runImport(app, e.target.files[0]),
  });

  const top = h('header', { class: 'topbar' },
    h('h1', {}, 'Decks'),
    h('button', {
      class: 'icon-btn', 'aria-label': 'Menu', html: icon('more').outerHTML,
      onclick: (e) => menu(e.currentTarget, [
        { label: 'Import deck…', action: () => fileInput.click() },
        { label: 'Back up everything', action: () => runBackup() },
        { label: 'Settings', action: () => navigate('#/settings') },
      ]),
    }),
  );

  const list = h('div', { class: 'scroll' });
  if (!visible.length) {
    list.append(h('div', { class: 'empty' },
      h('h2', {}, 'No decks yet'),
      h('p', {}, 'Bring your cards over from AnkiDroid:'),
      h('ol', {},
        h('li', {}, 'In AnkiDroid, open the menu → Export collection.'),
        h('li', {}, 'Choose "Collection package (.colpkg)" and keep "Include media" and "Include scheduling" on.'),
        h('li', {}, 'Tap Import below and pick that file.'),
      ),
      h('p', {}, 'Single decks (.apkg) work too.'),
    ));
  } else {
    list.append(h('div', { class: 'deck-header' }, h('span', { style: { textAlign: 'left' } }, ''), h('span', {}, 'New'), h('span', {}, 'Learn'), h('span', {}, 'Due'), h('span')));
    for (const d of visible) {
      const parts = d.name.split('::');
      // Skip rows under a collapsed parent
      if (parts.some((_, i) => i < parts.length - 1 && collapsed.has(visible.find((x) => x.name === parts.slice(0, i + 1).join('::'))?.id))) continue;
      const isParent = visible.some((x) => x.name.startsWith(d.name + '::'));
      const q = buildQueues({ decks, rootId: d.id, cards, todayLog: log, settings });
      const counts = [q.new.length, q.learning.length, q.review.length];
      const toggle = h('button', {
        class: `toggle ${isParent ? '' : 'leaf'} ${collapsed.has(d.id) ? '' : 'open'}`, 'aria-label': 'Expand',
        html: icon('chevron').outerHTML,
        onclick: async (e) => {
          e.stopPropagation();
          collapsed.has(d.id) ? collapsed.delete(d.id) : collapsed.add(d.id);
          await setKV('collapsed', [...collapsed]);
          renderDecks(app);
        },
      });
      list.append(h('div', { class: 'deck-row' },
        h('div', { class: 'deck-name', style: { paddingLeft: `${(parts.length - 1) * 18}px` }, onclick: () => navigate(`#/study/${d.id}`) },
          toggle, h('span', { class: 'label' }, parts.at(-1)),
        ),
        ...counts.map((n, i) => h('span', { class: `num ${['n', 'l', 'r'][i]} ${n ? '' : 'zero'}` }, n)),
        h('button', { class: 'icon-btn', 'aria-label': 'Deck options', html: icon('gear').outerHTML, onclick: () => deckOptions(app, d, settings) }),
      ));
    }
    const studied = log.length;
    list.append(h('div', { class: 'today' }, studied ? `Studied ${studied} card${studied === 1 ? '' : 's'} today` : 'No cards studied today yet'));
  }

  // Sync status, and refresh when another device's changes come in
  const syncLine = h('div', { class: 'today sync-line', onclick: () => navigate('#/settings') });
  const paintSync = (st) => {
    syncLine.hidden = st.state === 'off';
    syncLine.textContent = syncStatusText(st);
  };
  paintSync(getSyncStatus());
  list.append(syncLine);
  let prevState = getSyncStatus().state;
  const off = onSyncStatus((st) => {
    paintSync(st);
    if (prevState === 'syncing' && st.state === 'idle' && st.lastPulled) renderDecks(app);
    prevState = st.state;
  });
  onLeave(off);

  const fab = h('button', { class: 'fab', onclick: () => fileInput.click() }, '+ Import');
  app.replaceChildren(top, list, fab, fileInput);
}

async function runImport(app, file) {
  const status = h('p', {}, 'Opening file…');
  app.replaceChildren(
    h('header', { class: 'topbar' }, h('h1', {}, 'Importing')),
    h('div', { class: 'progress' }, h('div', { class: 'spinner' }), h('p', {}, file.name), status),
  );
  try {
    const res = await importFile(file, (msg) => (status.textContent = msg));
    toast(`Imported ${res.cards} cards from ${res.decks} deck${res.decks === 1 ? '' : 's'}`, 3500);
  } catch (err) {
    console.error(err);
    await dialog({ title: "Couldn't import that file", body: h('p', {}, err.message || String(err)) });
  }
  renderDecks(app);
}

async function runBackup() {
  if (await getSyncConfig()) {
    toast('Backing up to GitHub…', 20000);
    try {
      const r = await backupToRepo();
      toast(`Backed up ${r.cards} cards to GitHub`);
    } catch (err) {
      toast('Backup failed: ' + err.message, 5000);
    }
    return;
  }
  toast('Preparing backup…', 10000);
  try {
    const blob = await exportBackup((msg) => toast(msg, 10000));
    const a = h('a', { href: URL.createObjectURL(blob), download: `anki-ai-backup-${new Date().toISOString().slice(0, 10)}.zip` });
    document.body.append(a);
    a.click();
    a.remove();
    await setKV('lastBackup', Date.now());
    toast('Backup saved to your downloads');
  } catch (err) {
    toast('Backup failed: ' + err.message, 5000);
  }
}

async function deckOptions(app, deck, settings) {
  const newIn = h('input', { type: 'number', min: 0, value: deck.newPerDay ?? settings.newPerDay });
  const revIn = h('input', { type: 'number', min: 0, value: deck.revPerDay ?? settings.revPerDay });
  const choice = await dialog({
    title: deck.name.split('::').at(-1),
    body: h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'New cards per day'), newIn),
      h('label', { class: 'field' }, h('span', {}, 'Maximum reviews per day'), revIn),
      h('p', { class: 'note', style: { color: 'var(--muted)', fontSize: '14px' } }, 'Defaults for all decks live in Settings.'),
    ),
    buttons: [
      { label: 'Delete deck', value: 'delete', danger: true },
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'save', primary: true },
    ],
  });
  if (choice === 'save') {
    await db.decks.update(deck.id, { newPerDay: Number(newIn.value), revPerDay: Number(revIn.value) });
    renderDecks(app);
  } else if (choice === 'delete') {
    const sure = await dialog({
      title: 'Delete this deck?',
      body: h('p', {}, `"${deck.name}" and all its cards and subdecks will be removed from this device.`),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, danger: true }],
    });
    if (sure) {
      await deleteDeck(deck.id);
      toast('Deck deleted');
      renderDecks(app);
    }
  }
}
