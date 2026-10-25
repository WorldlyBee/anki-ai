// Study reminders handed off to the phone's calendar (a web app can't wake itself at a set time).
// A reminder is { repeat: 'daily' | 'alternate' | 'weekly', days: ['MO', ...], time: 'HH:MM' }.

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const JS_DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const DAY_NAMES = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

export function rrule(r) {
  if (r.repeat === 'alternate') return 'FREQ=DAILY;INTERVAL=2';
  if (r.repeat === 'weekly') return `FREQ=WEEKLY;BYDAY=${WEEKDAYS.filter((d) => r.days.includes(d)).join(',')}`;
  return 'FREQ=DAILY';
}

/** First time the reminder should fire, from now on (today if the time hasn't passed yet). */
export function firstOccurrence(r, now = new Date()) {
  const [hh, mm] = r.time.split(':').map(Number);
  const d = new Date(now);
  d.setHours(hh, mm, 0, 0);
  if (d <= now) d.setDate(d.getDate() + 1);
  if (r.repeat === 'weekly') {
    const allowed = new Set(r.days.map((x) => JS_DAY[x]));
    while (!allowed.has(d.getDay())) d.setDate(d.getDate() + 1);
  }
  return d;
}

export function describe(r) {
  if (!r) return 'Off';
  const [hh, mm] = r.time.split(':').map(Number);
  const time = new Date(2000, 0, 1, hh, mm).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (r.repeat === 'alternate') return `Every other day at ${time}`;
  if (r.repeat === 'weekly') {
    const days = WEEKDAYS.filter((d) => r.days.includes(d));
    if (days.length === 5 && !days.includes('SA') && !days.includes('SU')) return `Weekdays at ${time}`;
    return `${days.map((d) => DAY_NAMES[d]).join(', ')} at ${time}`;
  }
  return `Every day at ${time}`;
}

// Local "floating" time (no time zone): 8:00 stays 8:00 wherever you are
const stamp = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;
const icsText = (s) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** An .ics calendar file with a repeating event and an alert at the start time. */
export function icsFile({ reminder, deckName, deckId, link, now = new Date() }) {
  const start = firstOccurrence(reminder, now);
  const utcNow = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const title = `Aristotle: review ${deckName}`;
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Aristotle//Study reminders//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:aristotle-deck-${deckId}@aristotle.app`,
    `DTSTAMP:${utcNow}`,
    `DTSTART:${stamp(start)}`,
    'DURATION:PT15M',
    `RRULE:${rrule(reminder)}`,
    `SUMMARY:${icsText(title)}`,
    `DESCRIPTION:${icsText(`Time for your ${deckName} review.\nOpen it: ${link}`)}`,
    `URL:${link}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(`Time to review ${deckName}`)}`,
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Opens Google Calendar's "new event" screen pre-filled with the repeating reminder. */
export function googleCalendarLink({ reminder, deckName, link, now = new Date() }) {
  const start = firstOccurrence(reminder, now);
  const end = new Date(start.getTime() + 15 * 60_000);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Aristotle: review ${deckName}`,
    details: `Time for your ${deckName} review.\n\nOpen it: ${link}`,
    dates: `${stamp(start)}/${stamp(end)}`,
    ctz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    recur: `RRULE:${rrule(reminder)}`,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}
