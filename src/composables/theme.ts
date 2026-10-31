import { ref } from 'vue';

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'qihang-theme';
const theme = ref<ThemeMode>('light');

function apply(mode: ThemeMode) {
  theme.value = mode;
  document.documentElement.setAttribute('data-theme', mode);
}

export function useTheme() {
  return theme;
}

export function initTheme() {
  let saved: string | null = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch {}
  if (saved === 'dark' || saved === 'light') { apply(saved); return; }
  const preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  apply(preferDark ? 'dark' : 'light');
}

export function toggleTheme() {
  const next: ThemeMode = theme.value === 'dark' ? 'light' : 'dark';
  apply(next);
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
}
