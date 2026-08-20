import { App, Notice, requestUrl } from 'obsidian';
import { API_BASE_URL } from '../config/ApiConfig.ts';
import { LoginModal } from './LoginModal.ts';
import type { ObiSyncConfig } from '../config/ObiSyncConfig.ts';
import type { AuthenticatedUser, AuthSession } from './auth.types.ts';

type AuthServiceDependencies = {
	app: App;
	getConfig: () => ObiSyncConfig;
	saveConfig: () => Promise<void>;
	onSessionChanged: (
		previousUser: AuthenticatedUser | null,
		currentUser: AuthenticatedUser | null,
	) => void;
};

export class AuthService {
	private readonly app: App;
	private readonly getConfig: () => ObiSyncConfig;
	private readonly saveConfig: () => Promise<void>;
	private readonly onSessionChanged: AuthServiceDependencies['onSessionChanged'];
	private sessionRefreshTimer: number | null = null;
	public readonly clientId = crypto.randomUUID();

	public constructor(dependencies: AuthServiceDependencies) {
		this.app = dependencies.app;
		this.getConfig = dependencies.getConfig;
		this.saveConfig = dependencies.saveConfig;
		this.onSessionChanged = dependencies.onSessionChanged;
	}

	public get user(): AuthenticatedUser | null {
		return this.getConfig().user;
	}

	public get token(): string {
		return this.getConfig().token;
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
			Authorization: `Bearer ${this.token}`,
			'X-ObiSync-Client': this.clientId,
		};
	}

	public async ensureAuthenticated(): Promise<boolean> {
		if (this.token && (await this.validateCurrentToken())) return true;

		return new Promise((resolve) => {
			new LoginModal(
				this.app,
				(email, password) => this.login(email, password),
				resolve,
			).open();
		});
	}

	public scheduleSessionRefresh(): void {
		if (this.sessionRefreshTimer !== null) {
			window.clearTimeout(this.sessionRefreshTimer);
		}

		this.sessionRefreshTimer = window.setTimeout(() => {
			this.sessionRefreshTimer = null;
			void this.refreshSession();
		}, 250);
	}

	public async refreshSession(): Promise<void> {
		if (!this.token) return;

		const previousUser = this.user;
		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/auth/me`,
				headers: this.headers(),
				throw: false,
			});

			if (response.status !== 200) {
				await this.replaceSession('', null);
				new Notice('Sua sessão do obisync foi encerrada.');
				return;
			}

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) return;
			await this.replaceSession(this.token, payload.user, previousUser);
		} catch (error) {
			console.error(
				'Não foi possível atualizar a sessão do ObiSync:',
				error,
			);
		}
	}

	public async clearSession(): Promise<void> {
		await this.replaceSession('', null);
	}

	public destroy(): void {
		if (this.sessionRefreshTimer !== null) {
			window.clearTimeout(this.sessionRefreshTimer);
			this.sessionRefreshTimer = null;
		}
	}

	private async login(email: string, password: string): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/auth/login`,
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email, password }),
				throw: false,
			});

			if (response.status !== 200) return false;
			const session = response.json as AuthSession;
			if (!session.token || !session.user) return false;

			await this.replaceSession(session.token, session.user);
			return true;
		} catch (error) {
			console.error(error);
			return false;
		}
	}

	private async validateCurrentToken(): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/auth/me`,
				headers: this.headers(),
				throw: false,
			});
			if (response.status !== 200) return false;

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) return false;
			await this.replaceSession(this.token, payload.user);
			return true;
		} catch {
			return false;
		}
	}

	private async replaceSession(
		token: string,
		user: AuthenticatedUser | null,
		previousUser = this.user,
	): Promise<void> {
		const config = this.getConfig();
		const sessionChanged =
			config.token !== token || this.usersDiffer(previousUser, user);
		if (!sessionChanged) return;

		config.token = token;
		config.user = user;
		await this.saveConfig();

		this.onSessionChanged(previousUser, user);
	}

	private usersDiffer(
		left: AuthenticatedUser | null,
		right: AuthenticatedUser | null,
	): boolean {
		return (
			left?.id !== right?.id ||
			left?.name !== right?.name ||
			left?.email !== right?.email ||
			left?.role !== right?.role ||
			left?.active !== right?.active
		);
	}

}
