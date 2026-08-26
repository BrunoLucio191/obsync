import i18next from 'i18next';
import { moment } from 'obsidian';
import en from './locales/en.ts';
import pt from './locales/pt.ts';

type SupportedLanguage = 'en' | 'pt';

function resolveObsidianLanguage(): SupportedLanguage {
	// Obsidian sets moment's global locale to match the language configured
	// in its own settings, regardless of the OS locale.
	const locale = moment.locale().toLowerCase();
	return locale.startsWith('pt') ? 'pt' : 'en';
}

let initialized = false;

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

export function t(key: string, vars?: Record<string, unknown>): string {
	return i18next.t(key, vars);
}
