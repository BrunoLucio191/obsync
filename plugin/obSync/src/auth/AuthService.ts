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

/** Collaborators {@link AuthService} needs, injected instead of imported directly so it stays testable and decoupled from the plugin's own storage/lifecycle. */
type AuthServiceDependencies = {
	app: App;
	getConfig: () => ObSyncConfig;
	saveConfig: () => Promise<void>;
	onSessionChanged: (
		previousUser: AuthenticatedUser | null,
		currentUser: AuthenticatedUser | null,
	) => void;
};

/**
 * Owns the plugin's authentication lifecycle: storing tokens in Obsidian's
 * secret storage, keeping the access token fresh (proactively via a timer
 * and reactively on 401 responses), prompting the user to log in when
 * needed, and notifying the rest of the plugin when the signed-in user
 * changes.
 */
export class AuthService {
	private readonly app: App;
	private readonly getConfig: () => ObSyncConfig;
	private readonly saveConfig: () => Promise<void>;
	private readonly onSessionChanged: AuthServiceDependencies['onSessionChanged'];
	private accessToken: string;
	private refreshToken: string;
	private accessRefreshTimer: number | null = null;
	private sessionRefreshTimer: number | null = null;
	private refreshPromise: Promise<boolean> | null = null;

	/** Unique id for this plugin instance, sent to the backend to distinguish this client's own**
	 * broadcasted changes from other clients'. */
	public readonly clientId = crypto.randomUUID();

	/**
	 * Restores any previously stored tokens from Obsidian's secret storage
	 * and schedules a proactive refresh of the access token.
	 * @param dependencies - Collaborators for storage, config persistence, and session-change notification.
	 */
	public constructor(dependencies: AuthServiceDependencies) {
		this.app = dependencies.app;
		this.getConfig = dependencies.getConfig;
		this.saveConfig = dependencies.saveConfig;
		this.onSessionChanged = dependencies.onSessionChanged;
		this.accessToken = this.app.secretStorage.getSecret(ACCESS_TOKEN_SECRET_ID) ?? '';
		this.refreshToken = this.app.secretStorage.getSecret(REFRESH_TOKEN_SECRET_ID) ?? '';
		this.scheduleAccessRefresh();
	}

	/** The currently authenticated user's profile, or `null` when signed out. */
	public get user(): AuthenticatedUser | null {
		return this.getConfig().user;
	}

	/** @returns Whether both tokens and a user profile are present locally. */
	public isAuthenticated(): boolean {
		return Boolean(this.accessToken && this.refreshToken && this.user);
	}
	/** @returns true if the user is an admin */
	public isAdmin(): boolean {
		return this.user?.role === 'admin';
	}

	public isReadOnlyUser(): boolean {
		return this.user?.role === 'user';
	}

	/** @returns HTTP headers (bearer token, client id) to attach to authenticated backend requests. */
	public headers(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.accessToken}`,
			'X-ObSync-Client': this.clientId,
		};
	}

	/**
	 * Ensures the access token is valid (refreshing it if close to expiry)
	 * before an authenticated request is made.
	 * @returns Whether a usable access token is available.
	 */
	public prepareAuthenticatedRequest(): Promise<boolean> {
		return this.ensureFreshAccessToken();
	}

	/**
	 * Guarantees a valid session exists, restoring one from storage if
	 * possible or otherwise prompting the user to log in via {@link LoginModal}.
	 * @returns Whether the user ended up authenticated.
	 */
	public async ensureAuthenticated(): Promise<boolean> {
		if (await this.restoreStoredSession()) return true;
		await this.clearLocalSession();

		return new Promise((resolve) => {
			new LoginModal(
				this.app,
				(email, password) => this.login(email, password),
				resolve,
			).open();
		});
	}

	/**
	 * Exchanges the current access token for a short-lived ticket that can
	 * be used to authenticate a WebSocket upgrade request.
	 * @param channel - Which WebSocket channel the ticket is scoped to.
	 * @returns The ticket string, or `null` if it couldn't be obtained.
	 */
	public async createWebSocketTicket(channel: WebSocketChannel): Promise<string | null> {
		if (!(await this.ensureFreshAccessToken())) return null;

		let response = await this.requestWebSocketTicket(channel);
		if (response.status === 401 && (await this.refreshAccessToken())) {
			response = await this.requestWebSocketTicket(channel);
		}
		if (response.status !== 200) return null;

		const payload = response.json as Partial<WebSocketTicket>;
		return typeof payload.ticket === 'string' && payload.ticket ? payload.ticket : null;
	}

	/**
	 * Changes the current user's password on the backend.
	 * @param currentPassword - The user's existing password, for verification.
	 * @param newPassword - The password to set.
	 * @returns The updated result, with a localized error message on failure.
	 */
	public async changePassword(
		currentPassword: string,
		newPassword: string,
	): Promise<UserActionResult<null>> {
		if (!(await this.ensureFreshAccessToken())) {
			return { ok: false, error: t('auth.sessionExpired') };
		}

		try {
			let response = await this.requestChangePassword(currentPassword, newPassword);
			if (response.status === 401 && (await this.refreshAccessToken())) {
				response = await this.requestChangePassword(currentPassword, newPassword);
			}

			if (response.status === 200) return { ok: true, value: null };

			const payload = response.json as { error?: unknown; reason?: unknown };
			const fallback =
				typeof payload?.error === 'string' && payload.error.trim()
					? payload.error
					: t('auth.passwordChangeUnknownError');
			return { ok: false, error: localizeBackendError(payload?.reason, fallback) };
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

	/**
	 * Debounces a call to {@link refreshSession}, so multiple near-simultaneous
	 * triggers (e.g. several admin actions completing in quick succession)
	 * collapse into a single request.
	 */
	public scheduleSessionRefresh(): void {
		if (this.sessionRefreshTimer !== null) {
			window.clearTimeout(this.sessionRefreshTimer);
		}

		this.sessionRefreshTimer = window.setTimeout(() => {
			this.sessionRefreshTimer = null;
			void this.refreshSession();
		}, 250);
	}

	/**
	 * Re-fetches the current user's profile from the backend and updates
	 * local state if it changed (e.g. after an admin edits this user's role
	 * elsewhere). Clears the session and notifies the user if it turns out
	 * to be invalid.
	 */
	public async refreshSession(): Promise<void> {
		if (!(await this.ensureFreshAccessToken())) return;

		try {
			let response = await this.requestCurrentUser();
			if (response.status === 401 && (await this.refreshAccessToken())) {
				response = await this.requestCurrentUser();
			}

			if (response.status !== 200) {
				if (response.status === 401) {
					await this.clearLocalSession();
					new Notice(t('auth.sessionExpiredNotice'));
				}
				return;
			}

			const payload = response.json as { user?: AuthenticatedUser };
			if (payload.user) await this.updateCurrentUser(payload.user);
		} catch (error) {
			console.error(t('auth.sessionRefreshFailed'), error);
		}
	}

	/**
	 * Revokes the refresh token on the backend (best-effort) and clears the
	 * local session regardless of whether that request succeeds.
	 */
	public async logout(): Promise<void> {
		const refreshToken = this.refreshToken;
		try {
			if (refreshToken) {
				await requestUrl({
					url: `${getApiBaseUrl()}/auth/logout`,
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ refreshToken }),
					throw: false,
				});
			}
		} catch (error) {
			console.error(t('auth.sessionRevokeFailed'), error);
		} finally {
			await this.clearLocalSession();
		}
	}

	/** Clears the local session (tokens and user) without contacting the backend. */
	public async clearSession(): Promise<void> {
		await this.clearLocalSession();
	}

	/** Cancels any pending refresh timers. Must be called when the plugin unloads to avoid leaking timers. */
	public destroy(): void {
		if (this.accessRefreshTimer !== null) {
			window.clearTimeout(this.accessRefreshTimer);
			this.accessRefreshTimer = null;
		}
		if (this.sessionRefreshTimer !== null) {
			window.clearTimeout(this.sessionRefreshTimer);
			this.sessionRefreshTimer = null;
		}
	}

	/**
	 * Attempts to reuse the access token already in memory if it isn't
	 * expired, falling back to a refresh-token exchange.
	 * @returns Whether a valid session is now in place.
	 */
	private async restoreStoredSession(): Promise<boolean> {
		if (
			this.accessToken &&
			this.getConfig().accessTokenExpiresAt > Date.now() &&
			(await this.validateCurrentToken())
		) {
			return true;
		}

		return this.refreshAccessToken();
	}

	/**
	 * Submits credentials to the backend and, on success, stores the
	 * returned session.
	 * @param email - The account's e-mail address.
	 * @param password - The account's password.
	 * @returns Whether login succeeded.
	 */
	private async login(email: string, password: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${getApiBaseUrl()}/auth/login`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password }),
				throw: false,
			});

			if (response.status !== 200) return false;
			const session = response.json as AuthSession;
			if (!this.isValidSession(session)) return false;

			await this.acceptSession(session);
			return true;
		} catch (error) {
			console.error(error);
			return false;
		}
	}

	/**
	 * Checks that the in-memory access token is still accepted by the
	 * backend, refreshing the cached user profile if so.
	 * @returns Whether the token is still valid.
	 */
	private async validateCurrentToken(): Promise<boolean> {
		try {
			const response = await this.requestCurrentUser();
			if (response.status !== 200) return false;

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) return false;
			await this.updateCurrentUser(payload.user);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Resolves immediately if the access token has enough remaining
	 * lifetime, otherwise triggers a refresh-token exchange.
	 * @returns Whether a fresh-enough access token is available afterward.
	 */
	private ensureFreshAccessToken(): Promise<boolean> {
		if (
			this.accessToken &&
			this.getConfig().accessTokenExpiresAt > Date.now() + REFRESH_EARLY_MS
		) {
			return Promise.resolve(true);
		}
		return this.refreshAccessToken();
	}

	/**
	 * Exchanges the refresh token for a new session, coalescing concurrent
	 * callers onto a single in-flight request so simultaneous 401s don't
	 * each trigger their own refresh.
	 * @returns Whether the refresh succeeded.
	 */
	private refreshAccessToken(): Promise<boolean> {
		if (this.refreshPromise) return this.refreshPromise;

		this.refreshPromise = this.exchangeRefreshToken().finally(() => {
			this.refreshPromise = null;
		});
		return this.refreshPromise;
	}

	/**
	 * Performs the actual refresh-token HTTP exchange. Clears the local
	 * session and notifies the user if the refresh token itself was
	 * rejected.
	 * @returns Whether the refresh succeeded.
	 */
	private async exchangeRefreshToken(): Promise<boolean> {
		if (!this.refreshToken) return false;

		try {
			const response = await requestUrl({
				url: `${getApiBaseUrl()}/auth/refresh`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ refreshToken: this.refreshToken }),
				throw: false,
			});

			if (response.status !== 200) {
				if (response.status === 401) {
					await this.clearLocalSession();
					new Notice(t('auth.sessionExpiredNotice'));
				}
				return false;
			}

			const session = response.json as AuthSession;
			if (!this.isValidSession(session)) return false;
			await this.acceptSession(session);
			return true;
		} catch (error) {
			console.error(t('auth.sessionRenewFailed'), error);
			return false;
		}
	}

	/**
	 * Persists a newly received session: stores tokens in secret storage,
	 * updates the plugin config, reschedules the proactive refresh timer,
	 * and fires {@link onSessionChanged} if the signed-in user actually changed.
	 * @param session - The session returned by a login or refresh call.
	 */
	private async acceptSession(session: AuthSession): Promise<void> {
		const previousUser = this.user;
		this.accessToken = session.token;
		this.refreshToken = session.refreshToken;
		this.app.secretStorage.setSecret(ACCESS_TOKEN_SECRET_ID, this.accessToken);
		this.app.secretStorage.setSecret(REFRESH_TOKEN_SECRET_ID, this.refreshToken);

		const config = this.getConfig();
		config.accessTokenExpiresAt = Date.now() + session.expiresIn * 1_000;
		config.user = session.user;
		await this.saveConfig();
		this.scheduleAccessRefresh();

		if (this.usersDiffer(previousUser, session.user)) {
			this.onSessionChanged(previousUser, session.user);
		}
	}

	/**
	 * Updates the cached user profile and notifies listeners only if the
	 * profile actually changed.
	 * @param user - The freshly fetched user profile.
	 */
	private async updateCurrentUser(user: AuthenticatedUser): Promise<void> {
		const previousUser = this.user;
		if (!this.usersDiffer(previousUser, user)) return;

		this.getConfig().user = user;
		await this.saveConfig();
		this.onSessionChanged(previousUser, user);
	}

	/**
	 * Wipes tokens and user profile from memory, secret storage, and
	 * config, cancels the refresh timer, and notifies listeners if there
	 * was actually a session to clear.
	 */
	private async clearLocalSession(): Promise<void> {
		const previousUser = this.user;
		const hadSession = Boolean(this.accessToken || this.refreshToken || previousUser);
		this.accessToken = '';
		this.refreshToken = '';
		this.app.secretStorage.setSecret(ACCESS_TOKEN_SECRET_ID, '');
		this.app.secretStorage.setSecret(REFRESH_TOKEN_SECRET_ID, '');

		if (this.accessRefreshTimer !== null) {
			window.clearTimeout(this.accessRefreshTimer);
			this.accessRefreshTimer = null;
		}
		const config = this.getConfig();
		config.accessTokenExpiresAt = 0;
		config.user = null;
		if (!hadSession) return;

		await this.saveConfig();
		this.onSessionChanged(previousUser, null);
	}

	/**
	 * (Re)schedules a timer that proactively refreshes the access token
	 * shortly before it expires, so most requests never have to react to a
	 * 401.
	 */
	private scheduleAccessRefresh(): void {
		if (this.accessRefreshTimer !== null) {
			window.clearTimeout(this.accessRefreshTimer);
			this.accessRefreshTimer = null;
		}

		const expiresAt = this.getConfig().accessTokenExpiresAt;
		if (!this.refreshToken || expiresAt <= 0) return;
		const delay = Math.max(1_000, expiresAt - Date.now() - REFRESH_EARLY_MS);
		this.accessRefreshTimer = window.setTimeout(() => {
			this.accessRefreshTimer = null;
			void this.refreshAccessToken();
		}, delay);
	}

	private requestCurrentUser() {
		return requestUrl({
			url: `${getApiBaseUrl()}/auth/me`,
			headers: this.headers(),
			throw: false,
		});
	}

	/** Sends a change-password request to the backend. */
	private requestChangePassword(currentPassword: string, newPassword: string) {
		return requestUrl({
			url: `${getApiBaseUrl()}/auth/change-password`,
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ currentPassword, newPassword }),
			throw: false,
		});
	}

	/** Requests a WebSocket authentication ticket for the given channel. */
	private requestWebSocketTicket(channel: WebSocketChannel) {
		return requestUrl({
			url: `${getApiBaseUrl()}/auth/ws-ticket`,
			method: 'POST',
			headers: this.headers(),
			body: JSON.stringify({ channel }),
			throw: false,
		});
	}

	/**
	 * Type guard verifying a parsed response body has all the fields
	 * required to be treated as a valid {@link AuthSession}.
	 * @param session - The partially-typed, untrusted response payload.
	 * @returns Whether `session` is a complete, well-formed session.
	 */
	private isValidSession(session: Partial<AuthSession>): session is AuthSession {
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

	/**
	 * Compares two user profiles field-by-field to decide whether a
	 * session-changed notification is warranted.
	 * @param left - The previously known user, or `null`.
	 * @param right - The newly fetched user, or `null`.
	 * @returns Whether any user-visible field differs.
	 */
	private usersDiffer(left: AuthenticatedUser | null, right: AuthenticatedUser | null): boolean {
		return (
			left?.id !== right?.id ||
			left?.name !== right?.name ||
			left?.email !== right?.email ||
			left?.role !== right?.role ||
			left?.active !== right?.active
		);
	}
}
