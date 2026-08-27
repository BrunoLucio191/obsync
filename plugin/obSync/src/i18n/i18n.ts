import i18next from 'i18next';
import { moment } from 'obsidian';
import en from './locales/en.ts';
import pt from './locales/pt.ts';

type SupportedLanguage = 'en' | 'pt';

/**
 * Maps Obsidian's configured display language to one of the plugin's
 * supported translation bundles.
 * @returns `'pt'` if Obsidian's language starts with `pt`, otherwise `'en'`.
 */
function resolveObsidianLanguage(): SupportedLanguage {
	// Obsidian sets moment's global locale to match the language configured
	// in its own settings, regardless of the OS locale.
	const locale = moment.locale().toLowerCase();
	return locale.startsWith('pt') ? 'pt' : 'en';
}

let initialized = false;

/**
 * Initializes i18next with the plugin's inline translation resources.
 * Safe to call multiple times; only the first call has an effect. Must be
 * called (once) before {@link t} is used.
 */
export function initI18n(): void {
	if (initialized) return;
	initialized = true;

	// Resources are provided inline (no backend fetch), so i18next
	// initializes synchronously and `t()` is safe to call right after this.
	void i18next.init({
		lng: resolveObsidianLanguage(),
		fallbackLng: 'en',
		resources: {
			en: { translation: en },
			pt: { translation: pt },
		},
		interpolation: { escapeValue: false },
	});
}

/**
 * Translates a key from the active locale's bundle.
 * @param key - The dot-separated translation key (e.g. `'auth.loginTitle'`).
 * @param vars - Interpolation values to substitute into the translated string (e.g. `{{email}}`).
 * @returns The translated (or fallback-locale) string.
 */
export function t(key: string, vars?: Record<string, unknown>): string {
	return i18next.t(key, vars);
}
