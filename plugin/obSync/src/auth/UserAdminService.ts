import { requestUrl } from 'obsidian';
import { API_BASE_URL } from '../config/ApiConfig.ts';
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

export class UserAdminService {
	public constructor(private readonly auth: AuthService) {}

	public async listUsers(): Promise<UserActionResult<AuthenticatedUser[]>> {
		if (!this.hasSession() || !(await this.auth.prepareAuthenticatedRequest())) {
			return { ok: false, error: t('userAdmin.signInToViewUsers') };
		}

		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/api/users`,
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
				url: `${API_BASE_URL}/api/users`,
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
				url: `${API_BASE_URL}${path}`,
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

	private hasSession(): boolean {
		return this.auth.isAuthenticated();
	}

	private apiError(response: ApiResponse, fallback: string): string {
		const payload = response.json as { error?: unknown; reason?: unknown };
		const raw =
			typeof payload?.error === 'string' && payload.error.trim()
				? payload.error
				: response.text.trim() || fallback;
		return localizeBackendError(payload?.reason, raw);
	}

	private unknownRequestError(error: unknown, fallback: string): string {
		return error instanceof Error && error.message
			? error.message
			: fallback;
	}
}
