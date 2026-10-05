import { Notice, Plugin } from 'obsidian';
import { initI18n, t } from './i18n/i18n.ts';
import { AuthService } from './auth/AuthService.ts';
import { UserAdminService } from './auth/UserAdminService.ts';
import { CollaborationController } from './collab/CollaborationController.ts';
import {
	clearApiEndpoint,
	configureApiEndpoint,
	isApiEndpointConfigured,
} from './config/ApiConfig.ts';
import { DEFAULT_CONFIG, type ObSyncConfig } from './config/ObSyncConfig.ts';
import { ObSyncSettingTab } from './settings/ObSyncSettingTab.ts';
import { SyncInitialVault } from './sync/SyncInitialVault.ts';
import { SystemChannel } from './sync/SystemChannel.ts';
import { SyncVaultChanges } from './sync/SyncVaultChanges.ts';
import type {
	AuthenticatedUser,
	UserActionResult,
	UserRole,
} from './auth/auth.types.ts';
import { PathMuteRegistry } from './vault/PathMuteRegistry.ts';
import { RemoteVaultChangeService } from './vault/RemoteVaultChangeService.ts';
import { QueueManager } from './queue/QueueManager.ts';
import { KeyedLock } from './queue/KeyedLock.ts';
import { SyncBaseStore } from './vault/SyncBaseStore.ts';
import { ServerVersionMerger } from './vault/ServerVersionMerger.ts';

type StorageConfig = (Partial<ObSyncConfig> & { token?: unknown }) | null;

export default class ObSync extends Plugin {
	public config!: ObSyncConfig;
	static obsyncApp: ObSync;
	#auth!: AuthService;
	#userAdmin!: UserAdminService;
	#collaboration!: CollaborationController;
	#mutedPaths!: PathMuteRegistry;
	#queueManager!: QueueManager;
	#serverVersions!: ServerVersionMerger;
	#remoteChanges!: RemoteVaultChangeService;
	#systemChannel!: SystemChannel;
	#initialVaultSync!: SyncInitialVault;
	#vaultChangeSync!: SyncVaultChanges;
	#settingTab: ObSyncSettingTab | null = null;
	#synchronizationStarted = false;
	#fullSyncTimer: number | null = null;

	public async onload(): Promise<void> {
		ObSync.obsyncApp = this;
		initI18n();
		await this.#loadSettings();
		try {
			this.#applyBackendUrl(this.config.backendUrl);
		} catch (error) {
			console.error(t('settings.backend.notConfigured'), error);
		}
		this.#composeServices();

		this.#settingTab = new ObSyncSettingTab(this.app, this, this);
		this.addSettingTab(this.#settingTab);
		this.app.workspace.onLayoutReady(() => {
			void this.#initializeSynchronization().catch((error) => {
				console.error(error);
			});
		});
	}

	public onunload(): void {
		if (this.#fullSyncTimer !== null)
			window.clearTimeout(this.#fullSyncTimer);
		this.#systemChannel.disconnect();
		this.#collaboration.destroy();
		this.#auth.destroy();
		this.#mutedPaths.clear();
	}

	public async openLogin(): Promise<boolean> {
		const authenticated = await this.#auth.ensureAuthenticated();
		if (!authenticated) return false;

		if (!this.#synchronizationStarted) {
			this.#synchronizationStarted = true;
			try {
				this.#startSynchronization();
			} catch (error) {
				this.#synchronizationStarted = false;
				console.error(t('plugin.syncStartFailed'), error);
				new Notice(t('plugin.loginCompletedSyncFailed'));
				return false;
			}
		} else {
			this.#systemChannel.connect();
			this.#collaboration.scheduleActiveRoomSync();
		}

		return true;
	}
	public async ensureLogin(): Promise<boolean> {
		const authenticated = await this.#auth.ensureAuthenticated();
		if (!authenticated) {
			return false;
		}
		return true;
	}

	/** Opens the login right away, so another account can sign in. */
	public async logout(): Promise<void> {
		await this.#auth.logout();
		this.app.workspace.updateOptions();
		const login = await this.#auth.ensureAuthenticated();
		if (!login) {
			new Notice(t('plugin.signedOut'));
			return;
		}
		this.#systemChannel.connect();
		this.#collaboration.scheduleActiveRoomSync();
	}

	public isAuthenticated(): boolean {
		return this.#auth.isAuthenticated();
	}

	public listUsers(): Promise<UserActionResult<AuthenticatedUser[]>> {
		return this.#userAdmin.listUsers();
	}

	public createUser(input: {
		name: string;
		email: string;
		password: string;
		role: UserRole;
	}): Promise<UserActionResult<AuthenticatedUser>> {
		return this.#userAdmin.createUser(input);
	}

	public updateUserRole(
		userId: number,
		role: UserRole,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.#userAdmin.updateUserRole(userId, role);
	}

	public updateUserStatus(
		userId: number,
		active: boolean,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.#userAdmin.updateUserStatus(userId, active);
	}

	public deleteUser(
		userId: number,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.#userAdmin.deleteUser(userId);
	}

	public updateUserName(
		userId: number,
		name: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.#userAdmin.updateUserName(userId, name);
	}

	public resetUserPassword(
		userId: number,
		newPassword: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.#userAdmin.resetUserPassword(userId, newPassword);
	}

	public changePassword(
		currentPassword: string,
		newPassword: string,
	): Promise<UserActionResult<null>> {
		return this.#auth.changePassword(currentPassword, newPassword);
	}

	public changeColor(color: string): Promise<UserActionResult<null>> {
		return this.#auth.changeColor(color);
	}

	public async setBackendUrl(url: string): Promise<UserActionResult<null>> {
		const previousUrl = this.config.backendUrl;
		const wasConfigured = isApiEndpointConfigured();

		try {
			this.#applyBackendUrl(url);
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof Error
						? error.message
						: JSON.stringify(error),
			};
		}

		this.config.backendUrl = url.trim();
		await this.#saveSettings();

		// Tokens from the old backend are never sent to the new one
		if (wasConfigured && previousUrl !== this.config.backendUrl) {
			await this.#auth.clearSession();
		}

		return { ok: true, value: null };
	}

	#applyBackendUrl(url: string): void {
		if (!url.trim()) {
			clearApiEndpoint();
			return;
		}
		configureApiEndpoint(url);
	}

	#composeServices(): void {
		this.#auth = new AuthService({
			app: this.app,
			getConfig: () => this.config,
			saveConfig: () => this.#saveSettings(),
			onSessionChanged: (previousUser, currentUser) =>
				this.#handleSessionChanged(previousUser, currentUser),
		});
		this.#userAdmin = new UserAdminService(this.#auth);
		this.#mutedPaths = new PathMuteRegistry();
		this.#collaboration = new CollaborationController(this.app, this.#auth);
		this.#queueManager = new QueueManager(new KeyedLock());
		const pluginDir =
			this.manifest.dir ??
			`${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		this.#serverVersions = new ServerVersionMerger(
			this.app,
			this.#mutedPaths,
			new SyncBaseStore(this.app.vault.adapter, `${pluginDir}/sync-base`),
		);
		this.#remoteChanges = new RemoteVaultChangeService(
			this.app,
			this.#auth,
			this.#mutedPaths,
			this.#collaboration,
			this.#queueManager,
			this.#serverVersions,
			() => this.#scheduleFullSync(),
		);
		this.#initialVaultSync = new SyncInitialVault(
			this.app,
			this.#auth,
			this.#mutedPaths,
			this.#queueManager,
			this.#serverVersions,
		);
		this.#systemChannel = new SystemChannel(
			this.#auth,
			this.#remoteChanges,
			this.app,
			this.#initialVaultSync,
		);
		this.#vaultChangeSync = new SyncVaultChanges(
			this,
			this.#auth,
			this.#mutedPaths,
			this.#collaboration,
			this.#queueManager,
		);
	}

	/** Debounced, so several folders a regular user missed in a row cost a single download. */
	#scheduleFullSync(): void {
		if (this.#fullSyncTimer !== null)
			window.clearTimeout(this.#fullSyncTimer);
		this.#fullSyncTimer = window.setTimeout(() => {
			this.#fullSyncTimer = null;
			void this.#initialVaultSync.sync();
		}, 1_000);
	}

	async #initializeSynchronization(): Promise<void> {
		if (this.#synchronizationStarted) return;
		// Without a backend, ensureAuthenticated() would open the login on every startup
		if (!isApiEndpointConfigured()) return;
		if (!(await this.#auth.ensureAuthenticated())) {
			new Notice(t('plugin.signInToSync'));
			return;
		}

		this.#synchronizationStarted = true;
		this.#startSynchronization();
	}

	#startSynchronization(): void {
		this.#systemChannel.connect();
		this.registerEditorExtension(this.#collaboration.editorExtensions);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.#collaboration.scheduleActiveRoomSync();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.#collaboration.scheduleActiveRoomSync();
			}),
		);
		this.#vaultChangeSync.initialize();
		this.#collaboration.scheduleActiveRoomSync();
		void this.#initialVaultSync.sync();
	}

	#handleSessionChanged(
		previousUser: AuthenticatedUser | null,
		currentUser: AuthenticatedUser | null,
	): void {
		this.#refreshSettingsTab();

		if (!currentUser) {
			this.#collaboration.disconnect();
			this.#systemChannel.disconnect();
			return;
		}

		if (!this.#synchronizationStarted || previousUser === null) return;
		this.#systemChannel.connect();
		this.#collaboration.refreshAfterProfileChange();
	}

	#refreshSettingsTab(): void {
		this.#settingTab?.update();
	}

	async #loadSettings(): Promise<void> {
		const storedConfig = (await this.loadData()) as StorageConfig;
		this.config = Object.assign({}, DEFAULT_CONFIG, storedConfig ?? {});
	}

	async #saveSettings(): Promise<void> {
		await this.saveData(this.config);
	}
	static sameAppIntance() {
		return ObSync.obsyncApp;
	}
}
