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
import type { AuthenticatedUser, UserActionResult, UserRole } from './auth/auth.types.ts';
import { PathMuteRegistry } from './vault/PathMuteRegistry.ts';
import { RemoteVaultChangeService } from './vault/RemoteVaultChangeService.ts';
import { WorkerFather } from './Workers/WorkerFather.ts';
/**
 * ObSync's Obsidian plugin entry point. Wires together authentication,
 * collaborative editing, and vault-change synchronization, and exposes the
 * account/user-management operations the settings UI calls into.
 */

type StorageConfig = (Partial<ObSyncConfig> & { token?: unknown }) | null;

export default class ObSync extends Plugin {
	public config!: ObSyncConfig;
	static obsyncApp: ObSync;
	private auth!: AuthService;
	private userAdmin!: UserAdminService;
	private collaboration!: CollaborationController;
	private mutedPaths!: PathMuteRegistry;
	private remoteChanges!: RemoteVaultChangeService;
	private systemChannel!: SystemChannel;
	private initialVaultSync!: SyncInitialVault;
	private vaultChangeSync!: SyncVaultChanges;
	private workerFather!: WorkerFather;
	private settingTab: ObSyncSettingTab | null = null;
	private synchronizationStarted = false;

	/**
	 * Obsidian lifecycle hook: loads persisted config, applies the saved
	 * backend URL, constructs all services, and registers the settings
	 * tab. Synchronization itself is deferred until the workspace layout
	 * is ready.
	 */
	public async onload(): Promise<void> {
		ObSync.obsyncApp = this;
		initI18n();
		await this.loadSettings();
		try {
			this.applyBackendUrl(this.config.backendUrl);
		} catch (error) {
			// A previously-saved URL should already be valid, but never let a
			// stored config value keep the whole plugin from loading.
			console.error(t('settings.backend.notConfigured'), error);
		}
		this.composeServices();

		this.settingTab = new ObSyncSettingTab(this.app, this, this);
		this.addSettingTab(this.settingTab);
		this.app.workspace.onLayoutReady(() => {
			void this.initializeSynchronization();
		});
	}

	/** Obsidian lifecycle hook: tears down active connections and timers when the plugin is disabled/unloaded. */
	public onunload(): void {
		this.systemChannel.disconnect();
		this.collaboration.destroy();
		this.auth.destroy();
		this.mutedPaths.clear();
	}

	/**
	 * Prompts the user to log in (if not already authenticated) and starts
	 * synchronization if this is the first successful login, or
	 * reconnects/resyncs if synchronization had already started.
	 * @returns Whether the user ended up authenticated.
	 */
	public async openLogin(): Promise<boolean> {
		const authenticated = await this.auth.ensureAuthenticated();
		if (!authenticated) return false;

		if (!this.synchronizationStarted) {
			this.synchronizationStarted = true;
			try {
				this.startSynchronization();
			} catch (error) {
				this.synchronizationStarted = false;
				console.error(t('plugin.syncStartFailed'), error);
				new Notice(t('plugin.loginCompletedSyncFailed'));
				return false;
			}
		} else {
			this.systemChannel.connect();
			this.collaboration.scheduleActiveRoomSync();
		}

		return true;
	}

	/**
	 * Signs the current user out and, if the user chooses to sign back in
	 * immediately, reconnects synchronization for the new session.
	 */
	public async logout(): Promise<void> {
		await this.auth.logout();
		this.app.workspace.updateOptions();

		if (!(await this.auth.ensureAuthenticated())) {
			new Notice(t('plugin.signedOut'));
			return;
		}

		this.systemChannel.connect();
		this.collaboration.scheduleActiveRoomSync();
	}

	public isAuthenticated(): boolean {
		return this.auth.isAuthenticated();
	}

	public listUsers(): Promise<UserActionResult<AuthenticatedUser[]>> {
		return this.userAdmin.listUsers();
	}

	public createUser(input: {
		name: string;
		email: string;
		password: string;
		role: UserRole;
	}): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.createUser(input);
	}

	public updateUserRole(
		userId: number,
		role: UserRole,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.updateUserRole(userId, role);
	}

	public updateUserStatus(
		userId: number,
		active: boolean,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.updateUserStatus(userId, active);
	}

	public deleteUser(userId: number): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.deleteUser(userId);
	}

	public updateUserName(
		userId: number,
		name: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.updateUserName(userId, name);
	}

	public resetUserPassword(
		userId: number,
		newPassword: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.resetUserPassword(userId, newPassword);
	}

	public changePassword(
		currentPassword: string,
		newPassword: string,
	): Promise<UserActionResult<null>> {
		return this.auth.changePassword(currentPassword, newPassword);
	}

	/**
	 * Validates and applies a new backend URL, persists it, and — if it
	 * actually changed from a previously configured backend — clears the
	 * local session, since tokens issued by the old backend aren't valid
	 * for the new one.
	 * @param url - The backend URL entered by the user.
	 * @returns Success, or a localized error if the URL is invalid.
	 */
	public async setBackendUrl(url: string): Promise<UserActionResult<null>> {
		const previousUrl = this.config.backendUrl;
		const wasConfigured = isApiEndpointConfigured();

		try {
			this.applyBackendUrl(url);
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}

		this.config.backendUrl = url.trim();
		await this.saveSettings();

		// Switching to a different backend invalidates any session tied to the
		// previous one; drop it instead of sending its tokens somewhere new.
		if (wasConfigured && previousUrl !== this.config.backendUrl) {
			await this.auth.clearSession();
		}

		return { ok: true, value: null };
	}

	/**
	 * Configures (or clears, if blank) the global API endpoint used by all
	 * backend requests.
	 * @param url - The backend URL to apply.
	 * @throws Whatever {@link configureApiEndpoint} throws on an invalid URL.
	 */
	private applyBackendUrl(url: string): void {
		if (!url.trim()) {
			clearApiEndpoint();
			return;
		}
		configureApiEndpoint(url);
	}

	/** Constructs and wires together all of the plugin's services, in dependency order. */
	private composeServices(): void {
		this.auth = new AuthService({
			app: this.app,
			getConfig: () => this.config,
			saveConfig: () => this.saveSettings(),
			onSessionChanged: (previousUser, currentUser) =>
				this.handleSessionChanged(previousUser, currentUser),
		});
		this.userAdmin = new UserAdminService(this.auth);
		this.mutedPaths = new PathMuteRegistry();
		this.collaboration = new CollaborationController(this.app, this.auth);
		this.remoteChanges = new RemoteVaultChangeService(
			this.app,
			this.auth,
			this.mutedPaths,
			this.collaboration,
		);
		this.systemChannel = new SystemChannel(this.auth, this.remoteChanges);
		this.initialVaultSync = new SyncInitialVault(this.app, this.auth, this.mutedPaths);
		this.vaultChangeSync = new SyncVaultChanges(
			this,
			this.auth,
			this.mutedPaths,
			this.collaboration,
		);
	}

	/**
	 * Starts synchronization on plugin load if a backend is configured and
	 * a session can be established silently; otherwise leaves it to the
	 * user to configure the backend or sign in explicitly.
	 */
	private async initializeSynchronization(): Promise<void> {
		if (this.synchronizationStarted) return;
		// Without a configured backend, ensureAuthenticated() would pop the
		// login modal on every startup with no server to actually log in to.
		// Let the settings tab collect the backend URL first.
		if (!isApiEndpointConfigured()) return;
		if (!(await this.auth.ensureAuthenticated())) {
			new Notice(t('plugin.signInToSync'));
			return;
		}

		this.synchronizationStarted = true;
		this.startSynchronization();
	}

	/**
	 * Connects the system channel, registers collaborative editor
	 * extensions and vault-change listeners, and kicks off the initial
	 * full-vault sync.
	 */
	private startSynchronization(): void {
		this.systemChannel.connect();
		this.registerEditorExtension(this.collaboration.editorExtensions);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.collaboration.scheduleActiveRoomSync();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.collaboration.scheduleActiveRoomSync();
			}),
		);
		this.vaultChangeSync.initialize();
		this.collaboration.scheduleActiveRoomSync();
		void this.initialVaultSync.sync();
	}

	/**
	 * Reacts to the signed-in user changing (login, logout, or a profile
	 * update): refreshes the settings tab, and connects/disconnects
	 * collaboration and the system channel as appropriate.
	 * @param previousUser - The user before the change, or `null` if there wasn't one.
	 * @param currentUser - The user after the change, or `null` if now signed out.
	 */
	private handleSessionChanged(
		previousUser: AuthenticatedUser | null,
		currentUser: AuthenticatedUser | null,
	): void {
		this.refreshSettingsTab();

		if (!currentUser) {
			this.collaboration.disconnect();
			this.systemChannel.disconnect();
			return;
		}

		if (!this.synchronizationStarted || previousUser === null) return;
		this.systemChannel.connect();
		this.collaboration.refreshAfterProfileChange();
	}

	/** Re-renders the settings tab if it's currently mounted in the DOM. */

	private refreshSettingsTab(): void {
		if (this.settingTab?.containerEl.isConnected) {
			this.settingTab.update();
		}
	}

	/**
	 * Loads persisted config, merging it over {@link DEFAULT_CONFIG} and
	 * discarding a legacy `token` field from older plugin versions (which
	 * used a different auth storage scheme).
	 */

	private async loadSettings(): Promise<void> {
		const storedConfig = (await this.loadData()) as StorageConfig;
		this.config = Object.assign({}, DEFAULT_CONFIG, storedConfig ?? {});
	}

	private async saveSettings(): Promise<void> {
		await this.saveData(this.config);
	}
	static sameAppIntance() {
		return ObSync.obsyncApp;
	}
}
