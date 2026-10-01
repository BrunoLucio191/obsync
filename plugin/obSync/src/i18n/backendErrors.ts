import { t } from './i18n.ts';

// Known `reason` codes get a translation; anything else keeps the server's English `error`
const REASON_KEYS: Record<string, string> = {
	NOT_FOUND: 'userAdmin.userNotFound',
	LAST_ADMIN: 'userAdmin.lastAdmin',
	INVALID_ROLE: 'userAdmin.invalidRole',
	NAME_EXISTS: 'userAdmin.nameExists',
	EMAIL_EXISTS: 'userAdmin.emailAlreadyExists',
	INVALID_CURRENT_PASSWORD: 'auth.invalidCurrentPassword',
};

export function localizeBackendError(
	reason: unknown,
	fallback: string,
): string {
	if (typeof reason === 'string' && reason in REASON_KEYS) {
		return t(REASON_KEYS[reason] as string);
	}
	return fallback;
}
