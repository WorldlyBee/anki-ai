// Deck reminders: schedule, calendar file, Google Calendar link, bell on the deck, turning off.
const { chromium, devices } = require('playwright');
const path = require('path');
const fs = require('fs');
const assert = require('assert/strict');
const BASE = process.env.BASE || 'http://localhost:4173/';
const shots = process.argv[2];

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true, timezoneId: 'America/New_York' });
  await ctx.route('https://calendar.google.com/**', (r) => r.fulfill({ status: 200, body: 'calendar' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);
  await page.setInputFiles('input[accept=".apkg,.colpkg,.zip"]', path.resolve('test/fixtures/modern.apkg'));
  await page.waitForSelector('.deck-row');

  const openReminder = async () => {
    await page.click('.deck-row:has(.label:text-is("Cardiology")) .icon-btn');
    await page.click('.dialog .reminder-btn');
    await page.waitForSelector('.dialog h2:has-text("Remind me")');
  };
  await openReminder();
  await page.selectOption('.dialog label:has-text("Repeat") select', 'weekly');
  for (const d of ['TU', 'TH']) await page.click(`.dialog .chip[aria-label="${d}"]`); // weekdays preset → M W F
  await page.fill('.dialog input[type=time]', '07:30');
  if (shots) await page.screenshot({ path: `${shots}/reminder-dialog.png` });
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('.dialog button:has-text("Calendar file")')]);
  const ics = fs.readFileSync(await download.path(), 'utf8');
  console.log('downloaded:', download.suggestedFilename());
  console.log('calendar file:', ics.split('\r\n').filter((l) => /^(DTSTART|RRULE|SUMMARY|URL|TRIGGER)/.test(l)));
  assert.match(ics, /RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR/);
  assert.match(ics, /DTSTART:\d{8}T073000/);
  assert.match(ics, /URL:http:\/\/localhost:4173\/#\/study\/\d+/);

  await page.waitForSelector('.deck-row:has(.label:text-is("Cardiology")) .bell');
  console.log('bell on deck:', await page.getAttribute('.deck-row:has(.label:text-is("Cardiology")) .bell', 'title'));

  // Reopen: the saved schedule shows, and the Google Calendar link carries it
  await page.click('.deck-row:has(.label:text-is("Cardiology")) .icon-btn');
  console.log('deck options shows:', await page.innerText('.dialog .reminder-btn'));
  await page.click('.dialog .reminder-btn');
  const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('.dialog button:has-text("Google Calendar")')]);
  const g = new URL(popup.url());
  console.log('google calendar:', { text: g.searchParams.get('text'), dates: g.searchParams.get('dates'), recur: g.searchParams.get('recur'), ctz: g.searchParams.get('ctz') });
  assert.equal(g.searchParams.get('recur'), 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR');
  assert.equal(g.searchParams.get('ctz'), 'America/New_York');
  await popup.close();

  // Rename in the same dialog, then tap Reminder: the rename must not be lost
  await page.click('.deck-row:has(.label:text-is("Cardiology")) .icon-btn');
  await page.fill('.dialog label:has-text("Name") input', 'Cardio');
  await page.click('.dialog .reminder-btn');
  await page.selectOption('.dialog label:has-text("Repeat") select', 'off');
  await page.click('.dialog button:has-text("Google Calendar")');
  await page.waitForSelector('.deck-row .label:text-is("Cardio")');
  console.log('renamed + reminder off → bell:', await page.locator('.deck-row:has(.label:text-is("Cardio")) .bell').count());
  assert.equal(await page.locator('.deck-row:has(.label:text-is("Cardio")) .bell').count(), 0);
  console.log('errors:', errors.length ? errors : 'none');
  await browser.close();
  if (errors.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
