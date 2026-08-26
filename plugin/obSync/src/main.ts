import { Notice, Plugin } from 'obsidian';
import { AuthService } from './auth/AuthService.ts';
import { UserAdminService } from './auth/UserAdminService.ts';
import { CollaborationController } from './collab/CollaborationController.ts';
import {
	DEFAULT_CONFIG,
	type ObSyncConfig,
} from './config/ObSyncConfig.ts';
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

export default class ObSync extends Plugin {
	public config!: ObSyncConfig;
	private auth!: AuthService;
	private userAdmin!: UserAdminService;
	private collaboration!: CollaborationController;
	private mutedPaths!: PathMuteRegistry;
	private remoteChanges!: RemoteVaultChangeService;
	private systemChannel!: SystemChannel;
	private initialVaultSync!: SyncInitialVault;
	private vaultChangeSync!: SyncVaultChanges;
	private settingTab: ObSyncSettingTab | null = null;
	private synchronizationStarted = false;

	public async onload(): Promise<void> {
		await this.loadConfig();
		this.composeServices();

		this.settingTab = new ObSyncSettingTab(this.app, this, this);
		this.addSettingTab(this.settingTab);
		this.app.workspace.onLayoutReady(() => {
			void this.initializeSynchronization();
		});
	}

	public onunload(): void {
		this.systemChannel.disconnect();
		this.collaboration.destroy();
		this.auth.destroy();
		this.mutedPaths.clear();
	}

	public async openLogin(): Promise<boolean> {
		const authenticated = await this.auth.ensureAuthenticated();
		if (!authenticated) return false;

		if (!this.synchronizationStarted) {
			this.synchronizationStarted = true;
			try {
				this.startSynchronization();
			} catch (error) {
				this.synchronizationStarted = false;
				console.error(
					'Não foi possível iniciar a sincronização:',
					error,
				);
				new Notice(
					'Login concluído, mas a sincronização não pôde ser iniciada.',
				);
				return false;
			}
		} else {
			this.systemChannel.connect();
			this.collaboration.scheduleActiveRoomSync();
		}

		return true;
	}

	public async logout(): Promise<void> {
		await this.auth.logout();
		this.app.workspace.updateOptions();

		if (!(await this.auth.ensureAuthenticated())) {
			new Notice('Você saiu do ObSync.');
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

	public deleteUser(
		userId: number,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.deleteUser(userId);
	}

	public updateUserName(
		userId: number,
		name: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.userAdmin.updateUserName(userId, name);
	}

	public changePassword(
		currentPassword: string,
		newPassword: string,
	): Promise<UserActionResult<null>> {
		return this.auth.changePassword(currentPassword, newPassword);
	}

	private composeServices(): void {
		this.auth = new AuthService({
			app: this.app,
			getConfig: () => this.config,
			saveConfig: () => this.saveConfig(),
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
		this.initialVaultSync = new SyncInitialVault(
			this.app,
			this.auth,
			this.mutedPaths,
		);
		this.vaultChangeSync = new SyncVaultChanges(
			this,
			this.auth,
			this.mutedPaths,
			this.collaboration,
		);
	}

	private async initializeSynchronization(): Promise<void> {
		if (this.synchronizationStarted) return;
		if (!(await this.auth.ensureAuthenticated())) {
			new Notice('Entre para usar a sincronização colaborativa.');
			return;
		}

		this.synchronizationStarted = true;
		this.startSynchronization();
	}

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

	private refreshSettingsTab(): void {
		if (this.settingTab?.containerEl.isConnected) {
			this.settingTab.update();
		}
	}

	private async loadConfig(): Promise<void> {
		const storedConfig = (await this.loadData()) as
			| (Partial<ObSyncConfig> & { token?: unknown })
			| null;
		const { token: legacyToken, ...safeConfig } = storedConfig ?? {};
		this.config = Object.assign(
			{},
			DEFAULT_CONFIG,
			safeConfig,
		);

		if (legacyToken !== undefined) {
			await this.saveConfig();
		}
	}

	private async saveConfig(): Promise<void> {
		await this.saveData(this.config);
	}
}
