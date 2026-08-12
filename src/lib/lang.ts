export type Lang = 'fr' | 'en';

const LANG_KEY = 'cairn.lang';

export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'fr' || stored === 'en') return stored;
  } catch {
    // storage unavailable: fall back to the browser language
  }
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // better luck on the next load
  }
}

export function dateLocale(lang: Lang): string {
  return lang === 'fr' ? 'fr-FR' : 'en-GB';
}
