import { t } from './i18n.ts';

// Structured mutation endpoints (create/update/delete user, change password)
// return an English `error` message plus this stable `reason` code. Map
// recognized codes to a localized message; anything else (ad-hoc validation
// errors that have no reason code) falls back to the server's English text.
const REASON_KEYS: Record<string, string> = {
	not_found: 'userAdmin.userNotFound',
	last_admin: 'userAdmin.lastAdmin',
	invalid_role: 'userAdmin.invalidRole',
	name_exists: 'userAdmin.nameExists',
	email_exists: 'userAdmin.emailAlreadyExists',
	invalid_current_password: 'auth.invalidCurrentPassword',
};

/**
 * Translates a backend-provided stable `reason` code into a localized,
 * user-facing message.
 * @param reason - The `reason` field from a backend error payload (untyped since the payload is untrusted JSON).
 * @param fallback - The message to use when `reason` isn't a recognized code (e.g. the server's raw English error text).
 * @returns The localized message, or `fallback` if `reason` is unrecognized.
 */
export function localizeBackendError(reason: unknown, fallback: string): string {
	if (typeof reason === 'string' && reason in REASON_KEYS) {
		return t(REASON_KEYS[reason] as string);
	}
	return fallback;
}
