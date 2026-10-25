// Genuine lines from Aristotle's works (or reported of him by Diogenes Laertius), not the
// popular misattributions. Shown one per day on the "finished" screen.
export const QUOTES = [
  { text: 'All men by nature desire to know.', source: 'Metaphysics, I.1' },
  { text: 'For the things we have to learn before we can do them, we learn by doing them.', source: 'Nicomachean Ethics, II.1' },
  { text: 'One swallow does not make a summer, nor does one day.', source: 'Nicomachean Ethics, I.7' },
  { text: 'Education is an ornament in prosperity and a refuge in adversity.', source: 'as reported by Diogenes Laertius, Lives V.19' },
  { text: 'It is the mark of an educated man to look for precision in each class of things just so far as the nature of the subject admits.', source: 'Nicomachean Ethics, I.3' },
];

export function quoteOfTheDay(now = new Date()) {
  const day = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86_400_000);
  return QUOTES[day % QUOTES.length];
}
