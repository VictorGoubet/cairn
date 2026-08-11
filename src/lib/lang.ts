export type Lang = 'fr' | 'en';

const LANG_KEY = 'cairn.lang';

export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(LANG_KEY);
    if (stored === 'fr' || stored === 'en') return stored;
  } catch {
    // stockage indisponible: on retombe sur la langue du navigateur
  }
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function persistLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // meilleure chance au prochain chargement
  }
}

export function dateLocale(lang: Lang): string {
  return lang === 'fr' ? 'fr-FR' : 'en-GB';
}
