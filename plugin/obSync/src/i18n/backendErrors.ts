import { t } from './i18n.ts';

// Known `reason` codes get a translation; anything else keeps the server's English `error`
const REASON_KEYS: Record<string, string> = {
	not_found: 'userAdmin.userNotFound',
	last_admin: 'userAdmin.lastAdmin',
	invalid_role: 'userAdmin.invalidRole',
	name_exists: 'userAdmin.nameExists',
	email_exists: 'userAdmin.emailAlreadyExists',
	invalid_current_password: 'auth.invalidCurrentPassword',
};

export function localizeBackendError(reason: unknown, fallback: string): string {
	if (typeof reason === 'string' && reason in REASON_KEYS) {
		return t(REASON_KEYS[reason] as string);
	}
	return fallback;
}
