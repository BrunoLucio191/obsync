import { requestUrl } from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import { localizeBackendError } from '../i18n/backendErrors.ts';
import { t } from '../i18n/i18n.ts';
import type {
	AuthenticatedUser,
	UserActionResult,
	UserRole,
} from './auth.types.ts';
import type { AuthService } from './AuthService.ts';

type ApiResponse = {
	json: unknown;
	text: string;
};

/**
 * Client for the backend's admin-only user-management endpoints: listing,
 * creating, and mutating (role/status/name/password) user accounts. Every
 * write operation re-checks admin status and refreshes the auth session
 * afterward when it affects the currently signed-in user.
 */
export class UserAdminService {
	public constructor(private readonly auth: AuthService) {}

	/**
	 * Fetches the full list of registered users.
	 * @returns The user list, or a localized error if the request fails or the caller isn't authenticated.
	 */
	public async listUsers(): Promise<UserActionResult<AuthenticatedUser[]>> {
		if (!this.hasSession() || !(await this.auth.prepareAuthenticatedRequest())) {
			return { ok: false, error: t('userAdmin.signInToViewUsers') };
		}

		try {
			const response = await requestUrl({
				url: `${getApiBaseUrl()}/api/users`,
				headers: this.auth.headers(),
				throw: false,
			});
			if (response.status !== 200) {
				return {
					ok: false,
					error: this.apiError(response, t('userAdmin.couldNotLoadUsers')),
				};
			}

			const payload = response.json as { users?: AuthenticatedUser[] };
			if (!Array.isArray(payload.users)) {
				return {
					ok: false,
					error: t('userAdmin.invalidUserList'),
				};
			}
			return { ok: true, value: payload.users };
		} catch (error) {
			return {
				ok: false,
				error: this.unknownRequestError(
					error,
					t('userAdmin.couldNotLoadUsers'),
				),
			};
		}
	}

	/**
	 * Creates a new user account.
	 * @param input - The new account's display name, e-mail, initial password, and role.
	 * @returns The created user, or a localized error on failure.
	 */
	public async createUser(input: {
		name: string;
		email: string;
		password: string;
		role: UserRole;
	}): Promise<UserActionResult<AuthenticatedUser>> {
		if (!this.hasSession() || !(await this.auth.prepareAuthenticatedRequest())) {
			return { ok: false, error: t('userAdmin.signInToCreateUsers') };
		}

		try {
			const response = await requestUrl({
				url: `${getApiBaseUrl()}/api/users`,
				method: 'POST',
				headers: this.auth.headers(),
				body: JSON.stringify(input),
				throw: false,
			});
			if (response.status !== 201) {
				return {
					ok: false,
					error: this.apiError(response, t('userAdmin.couldNotCreateUser')),
				};
			}

			const payload = response.json as { user?: AuthenticatedUser };
			return payload.user
				? { ok: true, value: payload.user }
				: { ok: false, error: t('userAdmin.serverDidNotReturnUser') };
		} catch (error) {
			return {
				ok: false,
				error: this.unknownRequestError(
					error,
					t('userAdmin.couldNotCreateUser'),
				),
			};
		}
	}

	/** Changes a user's role. */
	public updateUserRole(
		userId: number,
		role: UserRole,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.mutateUser(
			`/api/users/${userId}/role`,
			'PATCH',
			{ role },
			t('userAdmin.couldNotChangeRole'),
		);
	}

	/** Activates or deactivates a user account. */
	public updateUserStatus(
		userId: number,
		active: boolean,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.mutateUser(
			`/api/users/${userId}/status`,
			'PATCH',
			{ active },
			t('userAdmin.couldNotChangeStatus'),
		);
	}

	/** Deletes a user account; the result carries the deleted user's last known data. */
	public deleteUser(
		userId: number,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.mutateUser(
			`/api/users/${userId}`,
			'DELETE',
			undefined,
			t('userAdmin.couldNotDeleteUser'),
		);
	}

	/** Renames a user account. */
	public updateUserName(
		userId: number,
		name: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.mutateUser(
			`/api/users/${userId}/name`,
			'PATCH',
			{ name },
			t('userAdmin.couldNotUpdateName'),
		);
	}

	/** Resets a user's password to an admin-supplied value. */
	public resetUserPassword(
		userId: number,
		newPassword: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.mutateUser(
			`/api/users/${userId}/password`,
			'PATCH',
			{ newPassword },
			t('userAdmin.couldNotResetPassword'),
		);
	}

	/**
	 * Shared implementation for the admin-only user mutation endpoints:
	 * verifies admin status (before and after re-authenticating, since the
	 * refresh could reveal the caller lost admin rights), sends the
	 * request, and refreshes the local session if the caller edited their
	 * own account.
	 * @param path - The API path to call, relative to the backend base URL.
	 * @param method - The HTTP method to use.
	 * @param body - The request payload, or `undefined` for methods that need none (e.g. DELETE).
	 * @param fallback - The localized error message to use if the backend didn't provide a more specific one.
	 * @returns The updated user, or a localized error on failure.
	 */
	private async mutateUser(
		path: string,
		method: 'PATCH' | 'DELETE',
		body: Record<string, unknown> | undefined,
		fallback: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		if (
			!this.auth.isAdmin() ||
			!(await this.auth.prepareAuthenticatedRequest()) ||
			!this.auth.isAdmin()
		) {
			return {
				ok: false,
				error: t('userAdmin.adminsOnly'),
			};
		}

		try {
			const response = await requestUrl({
				url: `${getApiBaseUrl()}${path}`,
				method,
				headers: this.auth.headers(),
				body: body ? JSON.stringify(body) : undefined,
				throw: false,
			});
			if (response.status !== 200) {
				return { ok: false, error: this.apiError(response, fallback) };
			}

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) {
				return {
					ok: false,
					error: t('userAdmin.invalidUserReturned'),
				};
			}

			if (payload.user.id === this.auth.user?.id) {
				await this.auth.refreshSession();
			}
			return { ok: true, value: payload.user };
		} catch (error) {
			return {
				ok: false,
				error: this.unknownRequestError(error, fallback),
			};
		}
	}

	/** @returns Whether the caller currently has a locally-stored session. */
	private hasSession(): boolean {
		return this.auth.isAuthenticated();
	}

	/**
	 * Extracts a user-facing error message from a failed API response,
	 * localizing it when the backend provided a recognized `reason` code.
	 * @param response - The failed response.
	 * @param fallback - The message to use if the response has no usable error text.
	 * @returns The localized (or fallback) error message.
	 */
	private apiError(response: ApiResponse, fallback: string): string {
		const payload = response.json as { error?: unknown; reason?: unknown };
		const raw =
			typeof payload?.error === 'string' && payload.error.trim()
				? payload.error
				: response.text.trim() || fallback;
		return localizeBackendError(payload?.reason, raw);
	}

	/**
	 * Extracts a user-facing message from a thrown error (e.g. a network
	 * failure), falling back to a generic message when the error carries
	 * no useful text.
	 * @param error - The caught error.
	 * @param fallback - The message to use if `error` has no usable message.
	 * @returns The error message to show the user.
	 */
	private unknownRequestError(error: unknown, fallback: string): string {
		return error instanceof Error && error.message
			? error.message
			: fallback;
	}
}
