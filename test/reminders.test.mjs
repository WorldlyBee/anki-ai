import assert from 'node:assert/strict';
import { rrule, firstOccurrence, describe, icsFile, googleCalendarLink } from '../src/reminders.js';

// Sunday 25 Oct 2026, 15:00 local
const now = new Date(2026, 9, 25, 15, 0);
const at = (d) => `${d.toDateString()} ${d.toTimeString().slice(0, 5)}`;

assert.equal(rrule({ repeat: 'daily' }), 'FREQ=DAILY');
assert.equal(rrule({ repeat: 'alternate' }), 'FREQ=DAILY;INTERVAL=2');
assert.equal(rrule({ repeat: 'weekly', days: ['WE', 'MO'] }), 'FREQ=WEEKLY;BYDAY=MO,WE');

assert.equal(at(firstOccurrence({ repeat: 'daily', time: '20:30' }, now)), 'Sun Oct 25 2026 20:30');
assert.equal(at(firstOccurrence({ repeat: 'daily', time: '08:00' }, now)), 'Mon Oct 26 2026 08:00');
assert.equal(at(firstOccurrence({ repeat: 'weekly', days: ['WE'], time: '08:00' }, now)), 'Wed Oct 28 2026 08:00');
assert.equal(at(firstOccurrence({ repeat: 'weekly', days: ['SU'], time: '20:00' }, now)), 'Sun Oct 25 2026 20:00');

assert.equal(describe({ repeat: 'weekly', days: ['MO', 'TU', 'WE', 'TH', 'FR'], time: '07:30' }).startsWith('Weekdays at 7:30'), true);
assert.equal(describe({ repeat: 'weekly', days: ['TU', 'MO', 'WE'], time: '18:00' }).startsWith('Mon, Tue, Wed at 6:00'), true);
assert.equal(describe(null), 'Off');

const ics = icsFile({ reminder: { repeat: 'weekly', days: ['MO', 'WE'], time: '08:00' }, deckName: 'Cardiology, Heart', deckId: 42, link: 'https://x.io/a/#/study/42', now });
assert.match(ics, /\r\nDTSTART:20261026T080000\r\n/);
assert.match(ics, /\r\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE\r\n/);
assert.match(ics, /SUMMARY:Aristotle: review Cardiology\\, Heart/);
assert.match(ics, /BEGIN:VALARM\r\nACTION:DISPLAY[\s\S]*TRIGGER:PT0M/);
assert.ok(ics.split('\r\n').every((l) => !l.includes('\n')));

const g = new URL(googleCalendarLink({ reminder: { repeat: 'alternate', time: '09:15' }, deckName: 'Pharm', link: 'https://x.io/', now }));
assert.equal(g.searchParams.get('recur'), 'RRULE:FREQ=DAILY;INTERVAL=2');
assert.equal(g.searchParams.get('dates'), '20261026T091500/20261026T093000');
console.log(ics);
console.log('reminder tests passed');
