import { db, getKV, setKV } from '../db.js';
import { getSettings, importFile, todayLog, deleteDeck, renameDeck, getStreak } from '../store.js';
import { buildQueues } from '../scheduler.js';
import { exportBackup } from '../backup.js';
import { h, icon, toast, dialog, menu } from './dom.js';
import { navigate, onLeave } from '../router.js';
import { WEEKDAYS, describe as describeReminder, icsFile, googleCalendarLink } from '../reminders.js';
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

  const top = h('header', { class: 'topbar brand' },
    h('div', { class: 'brand-mark' }, h('img', { src: 'icon-192.png', alt: '' }), h('span', {}, 'Aristotle')),
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
      h('img', { class: 'coin', src: 'icon-192.png', alt: '' }),
      h('h2', {}, 'Welcome to Aristotle'),
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
          d.reminder && h('span', { class: 'bell', title: describeReminder(d.reminder), 'aria-label': `Reminder: ${describeReminder(d.reminder)}` }, '🔔'),
        ),
        ...counts.map((n, i) => h('span', { class: `num ${['n', 'l', 'r'][i]} ${n ? '' : 'zero'}` }, n)),
        h('button', { class: 'icon-btn', 'aria-label': 'Deck options', html: icon('gear').outerHTML, onclick: () => deckOptions(app, d, settings) }),
      ));
    }
    const studied = log.length;
    const streak = await getStreak(settings);
    list.append(h('div', { class: 'today' },
      studied ? `Studied ${studied} card${studied === 1 ? '' : 's'} today` : 'No cards studied today yet',
      streak.current > 1 && h('span', { class: 'streak-inline' }, ` · 🔥 ${streak.current}-day streak`),
    ));
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
    const a = h('a', { href: URL.createObjectURL(blob), download: `aristotle-backup-${new Date().toISOString().slice(0, 10)}.zip` });
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
  const leaf = deck.name.split('::').at(-1);
  const parent = deck.name.split('::').slice(0, -1).join(' › ');
  const nameIn = h('input', { type: 'text', value: leaf, autocomplete: 'off' });
  const newIn = h('input', { type: 'number', min: 0, value: deck.newPerDay ?? settings.newPerDay });
  const revIn = h('input', { type: 'number', min: 0, value: deck.revPerDay ?? settings.revPerDay });
  const choice = await dialog({
    title: 'Deck options',
    body: (close) => h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Name'), nameIn, parent && h('small', {}, `Inside ${parent}`)),
      h('label', { class: 'field' }, h('span', {}, 'New cards per day'), newIn),
      h('label', { class: 'field' }, h('span', {}, 'Maximum reviews per day'), revIn),
      h('div', { class: 'field' }, h('span', {}, 'Reminder'),
        h('button', { type: 'button', class: 'btn reminder-btn', onclick: () => close('reminder') },
          describeReminder(deck.reminder), ' ›')),
      h('p', { class: 'note', style: { color: 'var(--muted)', fontSize: '14px' } }, 'Defaults for all decks live in Settings.'),
    ),
    buttons: [
      { label: 'Delete deck', value: 'delete', danger: true },
      { label: 'Cancel', value: null },
      { label: 'Save', value: 'save', primary: true },
    ],
  });
  if (choice === 'save' || choice === 'reminder') {
    try {
      await renameDeck(deck.id, nameIn.value);
    } catch (err) {
      await dialog({ title: "Couldn't rename the deck", body: h('p', {}, err.message) });
      return deckOptions(app, { ...deck }, settings);
    }
    await db.decks.update(deck.id, { newPerDay: Number(newIn.value), revPerDay: Number(revIn.value) });
    if (choice === 'reminder') return reminderDialog(app, await db.decks.get(deck.id));
    renderDecks(app);
  } else if (choice === 'delete') {
    const sure = await dialog({
      title: 'Delete this deck?',
      body: h('p', {}, `"${deck.name.split('::').join(' › ')}" and all its cards and subdecks will be removed (from your other devices too, if sync is on). You can get it back from a backup.`),
      buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, danger: true }],
    });
    if (sure) {
      await deleteDeck(deck.id);
      toast('Deck deleted');
      renderDecks(app);
    }
  }
}

const DAY_LETTERS = { MO: 'M', TU: 'T', WE: 'W', TH: 'T', FR: 'F', SA: 'S', SU: 'S' };

/** Pick a schedule, then hand it to the phone's calendar, which does the actual reminding. */
async function reminderDialog(app, deck) {
  const r = deck.reminder || { repeat: 'daily', days: ['MO', 'TU', 'WE', 'TH', 'FR'], time: '08:00' };
  const days = new Set(r.days);
  const repeatIn = h('select', {},
    [['off', 'Off'], ['daily', 'Every day'], ['alternate', 'Every other day'], ['weekly', 'Specific days']].map(([v, l]) =>
      h('option', { value: v, selected: (deck.reminder ? r.repeat : 'off') === v }, l)),
  );
  const chips = h('div', { class: 'day-chips' }, WEEKDAYS.map((d) =>
    h('button', {
      type: 'button', class: `chip ${days.has(d) ? 'on' : ''}`, 'aria-pressed': String(days.has(d)), 'aria-label': d,
      onclick: (e) => {
        days.has(d) ? days.delete(d) : days.add(d);
        e.currentTarget.classList.toggle('on', days.has(d));
        e.currentTarget.setAttribute('aria-pressed', String(days.has(d)));
      },
    }, DAY_LETTERS[d])));
  const timeIn = h('input', { type: 'time', value: r.time });
  const daysField = h('div', { class: 'field' }, h('span', {}, 'On'), chips);
  const timeField = h('label', { class: 'field' }, h('span', {}, 'At'), timeIn);
  const sync = () => {
    daysField.hidden = repeatIn.value !== 'weekly';
    timeField.hidden = repeatIn.value === 'off';
  };
  repeatIn.addEventListener('change', sync);
  sync();

  const choice = await dialog({
    title: `Remind me: ${deck.name.split('::').at(-1)}`,
    body: h('div', {},
      h('label', { class: 'field' }, h('span', {}, 'Repeat'), repeatIn),
      daysField,
      timeField,
      h('p', { class: 'note' }, "Your phone's calendar sends the reminder, right on time. Tapping it opens this deck. Use Google Calendar, or the calendar file for Samsung, Apple or Outlook calendars."),
    ),
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Calendar file', value: 'ics' },
      { label: 'Google Calendar', value: 'google', primary: true },
    ],
  });
  if (!choice) return;
  if (repeatIn.value === 'off') {
    await db.decks.update(deck.id, { reminder: null });
    toast('Reminder off. Delete the event from your calendar too.', 4000);
    return renderDecks(app);
  }
  if (repeatIn.value === 'weekly' && !days.size) {
    toast('Pick at least one day');
    return reminderDialog(app, deck);
  }
  const reminder = { repeat: repeatIn.value, days: WEEKDAYS.filter((d) => days.has(d)), time: timeIn.value || '08:00' };
  await db.decks.update(deck.id, { reminder });
  const deckName = deck.name.split('::').join(' › ');
  const link = `${location.origin}${location.pathname}#/study/${deck.id}`;
  if (choice === 'google') {
    window.open(googleCalendarLink({ reminder, deckName, link }), '_blank', 'noopener');
    toast('In Google Calendar, set the notification to "At time of event" and tap Save.', 6000);
  } else {
    const file = new File([icsFile({ reminder, deckName, deckId: deck.id, link })], `aristotle-${deckName.replace(/[^\w]+/g, '-').toLowerCase()}.ics`, { type: 'text/calendar' });
    const a = h('a', { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a);
    a.click();
    a.remove();
    toast('Calendar file downloaded. Open it and choose your calendar app.', 5000);
  }
  renderDecks(app);
}
