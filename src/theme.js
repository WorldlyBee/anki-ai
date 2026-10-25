const media = window.matchMedia('(prefers-color-scheme: dark)');
let mode = 'system';

export function applyTheme(next) {
  mode = next || 'system';
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', isDarkTheme() ? '#1d1d1f' : '#1d3566');
}

export const isDarkTheme = () => (mode === 'system' ? media.matches : mode === 'dark');

media.addEventListener('change', () => applyTheme(mode));
