import i18next from 'i18next';
import { moment } from 'obsidian';
import en from './locales/en.ts';
import pt from './locales/pt.ts';

type SupportedLanguage = 'en' | 'pt';

function resolveObsidianLanguage(): SupportedLanguage {
	const locale = moment.locale().toLowerCase();
	return locale.startsWith('pt') ? 'pt' : 'en';
}

let initialized = false;

/** Call before {@link t} is used. */
export function initI18n(): void {
	if (initialized) return;
	initialized = true;

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
