import { App, Notice, requestUrl } from 'obsidian';
import { getApiBaseUrl } from '../config/ApiConfig.ts';
import { localizeBackendError } from '../i18n/backendErrors.ts';
import { t } from '../i18n/i18n.ts';
import type { ObSyncConfig } from '../config/ObSyncConfig.ts';
import { LoginModal } from './LoginModal.ts';
import type {
	AuthenticatedUser,
	AuthSession,
	UserActionResult,
	WebSocketChannel,
	WebSocketTicket,
} from './auth.types.ts';

const ACCESS_TOKEN_SECRET_ID = 'obsync-access-token';
const REFRESH_TOKEN_SECRET_ID = 'obsync-refresh-token';
const REFRESH_EARLY_MS = 60_000;

type AuthServiceDependencies = {
	app: App;
	getConfig: () => ObSyncConfig;
	saveConfig: () => Promise<void>;
	onSessionChanged: (
		previousUser: AuthenticatedUser | null,
		currentUser: AuthenticatedUser | null,
	) => void;
};

/** Session lifecycle: tokens in secret storage, refreshed by a timer or on a 401. */
export class AuthService {
	readonly #app: App;
	readonly #getConfig: () => ObSyncConfig;
	readonly #saveConfig: () => Promise<void>;
	readonly #onSessionChanged: AuthServiceDependencies['onSessionChanged'];
	#accessToken: string;
	#refreshToken: string;
	#accessRefreshTimer: number | null = null;
	#sessionRefreshTimer: number | null = null;
	#refreshPromise: Promise<boolean> | null = null;

	/** Sent to the backend so this client can recognize its own broadcast changes. */
	public readonly clientId = crypto.randomUUID();

	public constructor(dependencies: AuthServiceDependencies) {
		this.#app = dependencies.app;
		this.#getConfig = dependencies.getConfig;
		this.#saveConfig = dependencies.saveConfig;
		this.#onSessionChanged = dependencies.onSessionChanged;
		this.#accessToken =
			this.#app.secretStorage.getSecret(ACCESS_TOKEN_SECRET_ID) ?? '';
		this.#refreshToken =
			this.#app.secretStorage.getSecret(REFRESH_TOKEN_SECRET_ID) ?? '';
		this.#scheduleAccessRefresh();
	}

	public get user(): AuthenticatedUser | null {
		return this.#getConfig().user;
	}

	public isAuthenticated(): boolean {
		return Boolean(this.#accessToken && this.#refreshToken && this.user);
	}
	public isAdmin(): boolean {
		return this.user?.role === 'admin';
	}

	public isReadOnlyUser(): boolean {
		return this.user?.role === 'user';
	}

	public headers(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.#accessToken}`,
			'X-ObSync-Client': this.clientId,
		};
	}

	public AuthHeaders(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.#accessToken}`,
			'X-ObSync-Client': this.clientId,
		};
	}
	public GeneHeader(savedGene: string): Record<string, string> {
		return {
			'X-ObSync-Gene': savedGene,
		};
	}

	public prepareAuthenticatedRequest(): Promise<boolean> {
		return this.#ensureFreshAccessToken();
	}

	/** Restores the stored session or opens the login modal. */
	public async ensureAuthenticated(): Promise<boolean | void> {
		if (await this.#restoreStoredSession()) return true;
		await this.#clearLocalSession();

		//console.log('number of times');
		return new Promise((resolve) => {
			new LoginModal(
				this.#app,
				(email, password) => this.#login(email, password),
				resolve,
			).open();
		});
	}

	/** Short-lived ticket that authenticates a WebSocket upgrade. */
	public async createWebSocketTicket(
		channel: WebSocketChannel,
	): Promise<string | null> {
		if (!(await this.#ensureFreshAccessToken())) return null;

		let response = await this.#requestWebSocketTicket(channel);
		if (response.status === 401 && (await this.#refreshAccessToken())) {
			response = await this.#requestWebSocketTicket(channel);
		}
		if (response.status !== 200) return null;

		const payload = response.json as Partial<WebSocketTicket>;
		return typeof payload.ticket === 'string' && payload.ticket
			? payload.ticket
			: null;
	}

	public async changePassword(
		currentPassword: string,
		newPassword: string,
	): Promise<UserActionResult<null>> {
		if (!(await this.#ensureFreshAccessToken())) {
			return { ok: false, error: t('auth.sessionExpired') };
		}

		try {
			let response = await this.#requestChangePassword(
				currentPassword,
				newPassword,
			);
			if (response.status === 401 && (await this.#refreshAccessToken())) {
				response = await this.#requestChangePassword(
					currentPassword,
					newPassword,
				);
			}

			if (response.status === 200) return { ok: true, value: null };

			const payload = response.json as {
				error?: unknown;
				reason?: unknown;
			};
			const fallback =
				typeof payload?.error === 'string' && payload.error.trim()
					? payload.error
					: t('auth.passwordChangeUnknownError');
			return {
				ok: false,
				error: localizeBackendError(payload?.reason, fallback),
			};
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof Error && error.message
						? error.message
						: t('auth.passwordChangeUnknownError'),
			};
		}
	}

	/** Adopting the returned profile reconnects the collaboration room with the new color. */
	public async changeColor(color: string): Promise<UserActionResult<null>> {
		if (!(await this.#ensureFreshAccessToken())) {
			return { ok: false, error: t('auth.sessionExpired') };
		}

		try {
			let response = await this.#requestChangeColor(color);
			if (response.status === 401 && (await this.#refreshAccessToken())) {
				response = await this.#requestChangeColor(color);
			}

			const payload = response.json as {
				user?: AuthenticatedUser;
				error?: unknown;
				reason?: unknown;
			};
			if (response.status === 200 && payload?.user) {
				await this.#updateCurrentUser(payload.user);
				return { ok: true, value: null };
			}

			const fallback =
				typeof payload?.error === 'string' && payload.error.trim()
					? payload.error
					: t('auth.colorChangeUnknownError');
			return {
				ok: false,
				error: localizeBackendError(payload?.reason, fallback),
			};
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof Error && error.message
						? error.message
						: t('auth.colorChangeUnknownError'),
			};
		}
	}

	/** Debounced, so several admin actions in a row cost a single request. */
	public scheduleSessionRefresh(): void {
		if (this.#sessionRefreshTimer !== null) {
			window.clearTimeout(this.#sessionRefreshTimer);
		}

		this.#sessionRefreshTimer = window.setTimeout(() => {
			this.#sessionRefreshTimer = null;
			void this.refreshSession();
		}, 250);
	}

	/** Picks up profile changes made elsewhere, e.g. an admin changing this user's role. */
	public async refreshSession(): Promise<void> {
		if (!(await this.#ensureFreshAccessToken())) return;

		try {
			let response = await this.#requestCurrentUser();
			if (response.status === 401 && (await this.#refreshAccessToken())) {
				response = await this.#requestCurrentUser();
			}

			if (response.status !== 200) {
				if (response.status === 401) {
					await this.#clearLocalSession();
					new Notice(t('auth.sessionExpiredNotice'));
				}
				return;
			}

			const payload = response.json as { user?: AuthenticatedUser };
			if (payload.user) await this.#updateCurrentUser(payload.user);
		} catch (error) {
			console.error(t('auth.sessionRefreshFailed'), error);
		}
	}

	public async logout(): Promise<void> {
		const refreshToken = this.#refreshToken;
		try {
			if (refreshToken) {
				await requestUrl({
					url: `${getApiBaseUrl()}/api/auth/logout`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ refreshToken }),
					throw: false,
				});
			}
		} catch (error) {
			console.error(t('auth.sessionRevokeFailed'), error);
		} finally {
			await this.#clearLocalSession();
		}
	}

	public async clearSession(): Promise<void> {
		await this.#clearLocalSession();
	}

	public destroy(): void {
		if (this.#accessRefreshTimer !== null) {
			window.clearTimeout(this.#accessRefreshTimer);
			this.#accessRefreshTimer = null;
		}
		if (this.#sessionRefreshTimer !== null) {
			window.clearTimeout(this.#sessionRefreshTimer);
			this.#sessionRefreshTimer = null;
		}
	}

	async #restoreStoredSession(): Promise<boolean> {
		if (
			this.#accessToken &&
			this.#getConfig().accessTokenExpiresAt > Date.now() &&
			(await this.#validateCurrentToken())
		) {
			return true;
		}

		return this.#refreshAccessToken();
	}

	async #login(email: string, password: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${getApiBaseUrl()}/api/auth/login`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password }),
				throw: false,
			});

			if (response.status !== 200) return false;
			const session = response.json as AuthSession;
			if (!this.#isValidSession(session)) return false;

			await this.#acceptSession(session);
			return true;
		} catch (error) {
			console.error(error);
			return false;
		}
	}

	async #validateCurrentToken(): Promise<boolean> {
		try {
			const response = await this.#requestCurrentUser();
			if (response.status !== 200) return false;

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) return false;
			await this.#updateCurrentUser(payload.user);
			return true;
		} catch {
			return false;
		}
	}

	#ensureFreshAccessToken(): Promise<boolean> {
		if (
			this.#accessToken &&
			this.#getConfig().accessTokenExpiresAt >
				Date.now() + REFRESH_EARLY_MS
		) {
			return Promise.resolve(true);
		}
		return this.#refreshAccessToken();
	}

	/** Concurrent callers share one in-flight request, so simultaneous 401s refresh once. */
	async #refreshAccessToken(): Promise<boolean> {
		if (await this.#refreshPromise) return this.#refreshPromise;

		this.#refreshPromise = this.#exchangeRefreshToken().finally(() => {
			this.#refreshPromise = null;
		});
		return this.#refreshPromise;
	}

	async #exchangeRefreshToken(): Promise<boolean> {
		if (!this.#refreshToken) return false;

		try {
			const response = await requestUrl({
				url: `${getApiBaseUrl()}/api/auth/refresh`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refreshToken: this.#refreshToken }),
				throw: false,
			});

			if (response.status !== 200) {
				if (response.status === 401) {
					await this.#clearLocalSession();
					new Notice(t('auth.sessionExpiredNotice'));
				}
				return false;
			}

			const session = response.json as AuthSession;
			if (!this.#isValidSession(session)) return false;
			await this.#acceptSession(session);
			return true;
		} catch (error) {
			console.error(t('auth.sessionRenewFailed'), error);
			return false;
		}
	}

	async #acceptSession(session: AuthSession): Promise<void> {
		const previousUser = this.user;
		this.#accessToken = session.token;
		this.#refreshToken = session.refreshToken;
		this.#app.secretStorage.setSecret(
			ACCESS_TOKEN_SECRET_ID,
			this.#accessToken,
		);
		this.#app.secretStorage.setSecret(
			REFRESH_TOKEN_SECRET_ID,
			this.#refreshToken,
		);

		const config = this.#getConfig();
		config.accessTokenExpiresAt = Date.now() + session.expiresIn * 1_000;
		config.user = session.user;
		await this.#saveConfig();
		this.#scheduleAccessRefresh();

		if (this.#usersDiffer(previousUser, session.user)) {
			this.#onSessionChanged(previousUser, session.user);
		}
	}

	async #updateCurrentUser(user: AuthenticatedUser): Promise<void> {
		const previousUser = this.user;
		if (!this.#usersDiffer(previousUser, user)) return;

		this.#getConfig().user = user;
		await this.#saveConfig();
		this.#onSessionChanged(previousUser, user);
	}

	async #clearLocalSession(): Promise<void> {
		const previousUser = this.user;
		const hadSession = Boolean(
			this.#accessToken || this.#refreshToken || previousUser,
		);
		this.#accessToken = '';
		this.#refreshToken = '';
		this.#app.secretStorage.setSecret(ACCESS_TOKEN_SECRET_ID, '');
		this.#app.secretStorage.setSecret(REFRESH_TOKEN_SECRET_ID, '');

		if (this.#accessRefreshTimer !== null) {
			window.clearTimeout(this.#accessRefreshTimer);
			this.#accessRefreshTimer = null;
		}
		const config = this.#getConfig();
		config.accessTokenExpiresAt = 0;
		config.user = null;
		if (!hadSession) return;

		await this.#saveConfig();
		this.#onSessionChanged(previousUser, null);
	}

	/** Refreshes shortly before expiry, so most requests never get a 401. */
	#scheduleAccessRefresh(): void {
		if (this.#accessRefreshTimer !== null) {
			window.clearTimeout(this.#accessRefreshTimer);
			this.#accessRefreshTimer = null;
		}

		const expiresAt = this.#getConfig().accessTokenExpiresAt;
		if (!this.#refreshToken || expiresAt <= 0) return;
		const delay = Math.max(
			1_000,
			expiresAt - Date.now() - REFRESH_EARLY_MS,
		);
		this.#accessRefreshTimer = window.setTimeout(() => {
			this.#accessRefreshTimer = null;
			void this.#refreshAccessToken();
		}, delay);
	}

	#requestCurrentUser() {
		return requestUrl({
			url: `${getApiBaseUrl()}/api/auth/me`,
			headers: this.headers(),
			throw: false,
		});
	}

	#requestChangePassword(currentPassword: string, newPassword: string) {
		return requestUrl({
			url: `${getApiBaseUrl()}/api/auth/change-password`,
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ currentPassword, newPassword }),
			throw: false,
		});
	}

	#requestChangeColor(color: string) {
		return requestUrl({
			url: `${getApiBaseUrl()}/api/auth/color`,
			method: 'PATCH',
			headers: this.headers(),
			body: JSON.stringify({ color }),
			throw: false,
		});
	}

	#requestWebSocketTicket(channel: WebSocketChannel) {
		return requestUrl({
			url: `${getApiBaseUrl()}/api/auth/ws-ticket`,
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ channel }),
			throw: false,
		});
	}

	#isValidSession(session: Partial<AuthSession>): session is AuthSession {
		return (
			typeof session.token === 'string' &&
			Boolean(session.token) &&
			typeof session.refreshToken === 'string' &&
			Boolean(session.refreshToken) &&
			typeof session.expiresIn === 'number' &&
			session.expiresIn > 0 &&
			Boolean(session.user)
		);
	}

	#usersDiffer(
		left: AuthenticatedUser | null,
		right: AuthenticatedUser | null,
	): boolean {
		return (
			left?.id !== right?.id ||
			left?.name !== right?.name ||
			left?.email !== right?.email ||
			left?.role !== right?.role ||
			left?.active !== right?.active ||
			left?.color !== right?.color
		);
	}
}
