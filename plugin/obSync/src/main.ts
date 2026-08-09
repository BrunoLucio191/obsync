import { MarkdownView, Notice, Plugin, requestUrl } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	ObiSyncSettings,
	ObiSyncSettingTab,
} from './settings.ts';
import { AuthenticatedUser, UserActionResult, UserRole } from './types.ts';
import { Extension } from '@codemirror/state';
import { closeCollabRoom, setupCollabRoom } from './collab.ts';
import { LoginModal } from './loginModal.ts';
import type { VaultChange } from './main.types.ts';
import { AuthSession } from './types.ts';
import { API_BASE_URL } from './constants.ts';
import { SyncVaultChanges } from './sync/SyncVaultChanges.ts';
import { SyncInitialVault } from './sync/SyncInitialVault.ts';

export default class ObSync extends Plugin {
	public config!: ObiSyncSettings;
	public currentCollabPath: string | null = null;
	private collabExtension: Extension[] = [];
	private syncStarted = false;
	private wsSystem: WebSocket | null = null;
	private collabRoomSyncTimer: number | null = null;
	private collabRoomGeneration = 0;
	private readonly clientId = crypto.randomUUID();
	private mutedPaths = new Map<string, number>();
	private sessionRefreshTimer: number | null = null;
	private readonly privateModeNotices = new Set<string>();
	private settingTab: ObiSyncSettingTab | null = null;
	private syncInitialVault: SyncInitialVault = new SyncInitialVault(this);
	private syncVaultChanges: SyncVaultChanges = new SyncVaultChanges(this);

	async onload() {
		await this.loadSettings();
		this.settingTab = new ObiSyncSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.app.workspace.onLayoutReady(() => {
			void this.initializeSync();
		});
	}

	public async openLogin(): Promise<boolean> {
		const authenticated = await this.ensureAuthenticated();
		if (!authenticated) return false;

		if (!this.syncStarted) {
			this.syncStarted = true;

			try {
				await this.startInitialSync();
			} catch (error) {
				this.syncStarted = false;

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
			this.connectSystemChannel();
			this.scheduleActiveCollabRoomSync();
		}

		return true;
	}

	private async initializeSync(): Promise<void> {
		if (this.syncStarted) return;
		if (!(await this.ensureAuthenticated())) {
			new Notice('Entre para usar a sincronização colaborativa.');
			return;
		}
		this.syncStarted = true;
		await this.startInitialSync();
		await this.syncVaultChanges.initialize();
	}

	private async startInitialSync(): Promise<void> {
		this.connectSystemChannel();
		this.registerEditorExtension(this.collabExtension);
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.scheduleActiveCollabRoomSync();
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', () => {
				this.scheduleActiveCollabRoomSync();
			}),
		);
		this.scheduleActiveCollabRoomSync();
		this.syncInitialVault.initialize();
	}

	private async ensureAuthenticated(): Promise<boolean> {
		if (this.config.token && (await this.validateCurrentToken()))
			return true;

		return new Promise((resolve) => {
			new LoginModal(
				this.app,
				async (email: string, password: string) =>
					this.login(email, password),
				resolve,
			).open();
		});
	}

	private async validateCurrentToken(): Promise<boolean> {
		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/auth/me`,
				headers: this.authHeaders(),
				throw: false,
			});
			if (response.status !== 200) return false;

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) return false;

			const previousUser = this.config.user;
			this.config.user = payload.user;
			if (
				!previousUser ||
				previousUser.name !== payload.user.name ||
				previousUser.email !== payload.user.email ||
				previousUser.role !== payload.user.role ||
				previousUser.active !== payload.user.active
			) {
				await this.saveSettings();
				this.refreshSettingsTab();
			}
			return true;
		} catch {
			return false;
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

			this.config.token = session.token;

			this.config.user = session.user;

			await this.saveSettings();

			this.refreshSettingsTab();

			return true;
		} catch (err) {
			console.error(err);
			return false;
		}
	}

	public async listUsers(): Promise<UserActionResult<AuthenticatedUser[]>> {
		if (!this.config.token || !this.config.user) {
			return {
				ok: false,
				error: 'Entre no ObiSync para ver os usuários.',
			};
		}

		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/api/users`,
				headers: this.authHeaders(),
				throw: false,
			});
			if (response.status !== 200) {
				return {
					ok: false,
					error: this.apiError(
						response,
						'Não foi possível carregar os usuários.',
					),
				};
			}

			const payload = response.json as { users?: AuthenticatedUser[] };
			if (!Array.isArray(payload.users)) {
				return {
					ok: false,
					error: 'O servidor retornou uma lista inválida.',
				};
			}
			return { ok: true, value: payload.users };
		} catch (error) {
			return {
				ok: false,
				error: this.unknownRequestError(
					error,
					'Não foi possível carregar os usuários.',
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
		if (!this.config.token || !this.config.user) {
			return {
				ok: false,
				error: 'Entre no ObiSync para criar usuários.',
			};
		}

		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/api/users`,
				method: 'POST',
				headers: this.authHeaders(),
				body: JSON.stringify(input),
				throw: false,
			});
			if (response.status !== 201) {
				return {
					ok: false,
					error: this.apiError(
						response,
						'Não foi possível criar o usuário.',
					),
				};
			}

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) {
				return {
					ok: false,
					error: 'O servidor não retornou o novo usuário.',
				};
			}
			return { ok: true, value: payload.user };
		} catch (error) {
			return {
				ok: false,
				error: this.unknownRequestError(
					error,
					'Não foi possível criar o usuário.',
				),
			};
		}
	}

	public async updateUserRole(
		userId: number,
		role: UserRole,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.adminUserMutation(
			`/api/users/${userId}/role`,
			'PATCH',
			{ role },
			'Não foi possível alterar o papel do usuário.',
		);
	}

	public async updateUserStatus(
		userId: number,
		active: boolean,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.adminUserMutation(
			`/api/users/${userId}/status`,
			'PATCH',
			{ active },
			'Não foi possível alterar o status do usuário.',
		);
	}

	public async deleteUser(
		userId: number,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.adminUserMutation(
			`/api/users/${userId}`,
			'DELETE',
			undefined,
			'Não foi possível excluir o usuário.',
		);
	}

	private async adminUserMutation(
		path: string,
		method: 'PATCH' | 'DELETE',
		body: Record<string, unknown> | undefined,
		fallback: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		if (!this.config.user || this.config.user.role !== 'admin') {
			return {
				ok: false,
				error: 'Apenas administradores podem executar esta ação.',
			};
		}

		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}${path}`,
				method,
				headers: this.authHeaders(),
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
					error: 'O servidor retornou um usuário inválido.',
				};
			}

			if (payload.user.id === this.config.user.id) {
				await this.refreshAuthenticatedSession();
			}
			return { ok: true, value: payload.user };
		} catch (error) {
			return {
				ok: false,
				error: this.unknownRequestError(error, fallback),
			};
		}
	}

	public async updateUserName(
		userId: number,
		name: string,
	): Promise<UserActionResult<AuthenticatedUser>> {
		return this.adminUserMutation(
			`/api/users/${userId}/name`,
			'PATCH',
			{ name },
			'Não foi possível atualizar o nome do usuário.',
		);
	}

	private apiError(
		response: { json: unknown; text: string },
		fallback: string,
	): string {
		const payload = response.json as { error?: unknown };
		if (typeof payload?.error === 'string' && payload.error.trim()) {
			return payload.error;
		}
		return response.text.trim() || fallback;
	}

	private unknownRequestError(error: unknown, fallback: string): string {
		return error instanceof Error && error.message
			? error.message
			: fallback;
	}

	public isAdmin(): boolean {
		return this.config.user?.role === 'admin';
	}

	public isReadOnlyUser(): boolean {
		return this.config.user?.role === 'user';
	}

	public canPublishGlobalChanges(): boolean {
		return this.config.user?.role === 'admin';
	}

	private async refreshAuthenticatedSession(): Promise<void> {
		if (!this.config.token) return;

		const previousUser = this.config.user;
		try {
			const response = await requestUrl({
				url: `${API_BASE_URL}/auth/me`,
				headers: this.authHeaders(),
				throw: false,
			});

			if (response.status !== 200) {
				this.config.token = '';
				this.config.user = null;
				await this.saveSettings();
				this.disconnectCollabRoom();
				this.refreshSettingsTab();
				new Notice('Sua sessão do obisync foi encerrada.');
				return;
			}

			const payload = response.json as { user?: AuthenticatedUser };
			if (!payload.user) return;
			this.config.user = payload.user;
			await this.saveSettings();
			this.refreshSettingsTab();

			if (
				!previousUser ||
				previousUser.name !== payload.user.name ||
				previousUser.role !== payload.user.role ||
				previousUser.active !== payload.user.active
			) {
				this.refreshConnectionsAfterProfileChange();
			}
		} catch (error) {
			console.error(
				'Não foi possível atualizar a sessão do ObiSync:',
				error,
			);
		}
	}

	private scheduleSessionRefresh(): void {
		if (this.sessionRefreshTimer !== null) {
			window.clearTimeout(this.sessionRefreshTimer);
		}
		this.sessionRefreshTimer = window.setTimeout(() => {
			this.sessionRefreshTimer = null;
			void this.refreshAuthenticatedSession();
		}, 250);
	}

	private refreshConnectionsAfterProfileChange(): void {
		if (!this.syncStarted) return;

		const activeFile = this.app.workspace.getActiveFile();
		this.disconnectCollabRoom();
		this.connectSystemChannel();
		if (activeFile?.extension === 'md') {
			void this.joinRoom(activeFile.path);
		}
	}

	private refreshSettingsTab(): void {
		if (this.settingTab?.containerEl.isConnected) {
			this.settingTab.getSettingDefinitions();
		}
	}

	public authHeaders(): Record<string, string> {
		return {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${this.config.token}`,
			'X-ObiSync-Client': this.clientId,
		};
	}

	private connectSystemChannel(): void {
		this.wsSystem?.close();
		const url = new URL(`${API_BASE_URL.replace(/^http/, 'ws')}/system`);
		url.searchParams.set('token', this.config.token);
		const socket = new WebSocket(url.toString());
		this.wsSystem = socket;

		socket.onmessage = (event) => {
			try {
				const change = JSON.parse(event.data as string) as VaultChange;
				if (change.originClientId !== this.clientId) {
					void this.applyRemoteChange(change);
				}
			} catch (error) {
				console.error('Evento de sincronização inválido:', error);
			}
		};

		socket.onclose = (event) => {
			if (this.wsSystem !== socket) return;
			this.wsSystem = null;
			if (event.code === 4003 && this.config.token) {
				this.scheduleSessionRefresh();
			}
		};
	}

	public mutePath(path: string): void {
		this.mutedPaths.set(path, Date.now() + 2_000);
	}

	public isMuted(path: string): boolean {
		for (const [mutedPath, until] of this.mutedPaths) {
			if (until < Date.now()) {
				this.mutedPaths.delete(mutedPath);
				continue;
			}
			if (path === mutedPath || path.startsWith(`${mutedPath}/`)) {
				return true;
			}
		}
		return false;
	}

	public isSamePathOrChild(rootPath: string, candidatePath: string): boolean {
		return (
			candidatePath === rootPath ||
			candidatePath.startsWith(`${rootPath}/`)
		);
	}

	public scheduleActiveCollabRoomSync(): void {
		if (this.collabRoomSyncTimer) {
			window.clearTimeout(this.collabRoomSyncTimer);
		}

		// O evento pode ocorrer antes de o Workspace atualizar getActiveFile().
		// Executar no próximo ciclo evita entrar por engano na sala anterior.
		this.collabRoomSyncTimer = window.setTimeout(() => {
			this.collabRoomSyncTimer = null;
			this.syncCollabRoomWithActiveFile();
		}, 0);
	}

	private syncCollabRoomWithActiveFile(): void {
		const activeFile = this.app.workspace.getActiveFile();

		if (!activeFile || activeFile.extension !== 'md') {
			this.disconnectCollabRoom();
			return;
		}

		if (this.currentCollabPath === activeFile.path) return;
		void this.joinRoom(activeFile.path);
	}

	public disconnectCollabRoom(): void {
		this.collabRoomGeneration += 1;

		if (!this.currentCollabPath && this.collabExtension.length === 0) {
			closeCollabRoom();
			return;
		}
		this.collabExtension.length = 0;
		this.app.workspace.updateOptions();
		closeCollabRoom();
		this.currentCollabPath = null;
	}

	public disconnectCollabRoomIfAffected(deletedPath: string): void {
		if (
			this.currentCollabPath &&
			this.isSamePathOrChild(deletedPath, this.currentCollabPath)
		) {
			this.disconnectCollabRoom();
		}
	}

	private async ensureParentFolder(filePath: string): Promise<void> {
		const parent = filePath.substring(0, filePath.lastIndexOf('/'));
		if (!parent) return;
		const adapter = this.app.vault.adapter;
		const parts = parent.split('/');
		let current = '';
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await adapter.exists(current))) {
				this.mutePath(current);
				await adapter.mkdir(current);
			}
		}
	}

	private async applyRemoteChange(change: VaultChange): Promise<void> {
		const adapter = this.app.vault.adapter;
		if (change.type === 'create') {
			if (this.isReadOnlyUser() && (await adapter.exists(change.path)))
				return;
			this.mutePath(change.path);
			if (change.isFolder) {
				if (!(await adapter.exists(change.path)))
					await adapter.mkdir(change.path);
			} else {
				await this.ensureParentFolder(change.path);
				await adapter.write(change.path, change.content);
			}
			return;
		}
		if (change.type === 'modify') {
			if (this.isReadOnlyUser() && (await adapter.exists(change.path)))
				return;
			this.mutePath(change.path);
			await this.ensureParentFolder(change.path);
			await adapter.write(change.path, change.content);
			return;
		}
		if (change.type === 'delete') {
			this.disconnectCollabRoomIfAffected(change.path);
			this.mutePath(change.path);

			const file = this.app.vault.getAbstractFileByPath(change.path);
			if (file) {
				await this.app.fileManager.trashFile(file);
				return;
			}

			if (!(await adapter.exists(change.path))) return;

			if (change.isFolder) {
				await adapter.rmdir(change.path, true);
			} else {
				await adapter.remove(change.path);
			}
			return;
		}

		this.mutePath(change.oldPath);
		this.mutePath(change.newPath);
		if (await adapter.exists(change.oldPath)) {
			await this.ensureParentFolder(change.newPath);
			await adapter.rename(change.oldPath, change.newPath);
		}
	}

	public async logout(): Promise<void> {
		this.config.token = '';
		this.config.user = null;
		await this.saveSettings();
		this.refreshSettingsTab();
		this.disconnectCollabRoom();
		this.wsSystem?.close();
		this.wsSystem = null;
		this.app.workspace.updateOptions();

		if (!(await this.ensureAuthenticated())) {
			new Notice('Você saiu do obisync.');
			return;
		}

		const activeFile = this.app.workspace.getActiveFile();
		this.connectSystemChannel();
		if (activeFile) void this.joinRoom(activeFile.path);
	}

	onunload(): void {
		if (this.collabRoomSyncTimer) {
			window.clearTimeout(this.collabRoomSyncTimer);
			this.collabRoomSyncTimer = null;
		}
		if (this.sessionRefreshTimer !== null) {
			window.clearTimeout(this.sessionRefreshTimer);
			this.sessionRefreshTimer = null;
		}
		this.disconnectCollabRoom();
		this.wsSystem?.close();
	}

	async joinRoom(filePath: string): Promise<void> {
		if (!this.config.user || this.currentCollabPath === filePath) return;

		this.disconnectCollabRoom();
		const generation = ++this.collabRoomGeneration;
		this.currentCollabPath = filePath;

		try {
			if (
				this.isReadOnlyUser() &&
				!this.privateModeNotices.has(filePath)
			) {
				this.privateModeNotices.add(filePath);
				new Notice(
					'Você está em modo privado: suas edições ficam apenas neste dispositivo.',
				);
			}

			const initialView =
				this.app.workspace.getActiveViewOfType(MarkdownView);

			if (!initialView || initialView.file?.path !== filePath) {
				this.disconnectCollabRoom();
				return;
			}

			const preparedRoom = await setupCollabRoom(
				filePath,
				initialView.editor.getValue(),
				this.config.user,
				this.config.token,
				(name: string) => {
					if (this.currentCollabPath === filePath) {
						new Notice(`${name} entrou nesta nota.`);
					}
				},
				(name: string) => {
					if (this.currentCollabPath === filePath) {
						new Notice(`${name} saiu desta nota.`);
					}
				},
			);

			if (
				!preparedRoom ||
				generation !== this.collabRoomGeneration ||
				this.currentCollabPath !== filePath
			) {
				return;
			}

			const activeView =
				this.app.workspace.getActiveViewOfType(MarkdownView);

			if (!activeView || activeView.file?.path !== filePath) {
				this.disconnectCollabRoom();
				return;
			}

			if (activeView.editor.getValue() !== preparedRoom.initialText) {
				const cursorOffset = activeView.editor.posToOffset(
					activeView.editor.getCursor(),
				);

				activeView.editor.setValue(preparedRoom.initialText);
				activeView.editor.setCursor(
					activeView.editor.offsetToPos(
						Math.min(cursorOffset, preparedRoom.initialText.length),
					),
				);
			}

			this.collabExtension.push(preparedRoom.extension);
			this.app.workspace.updateOptions();
			preparedRoom.connect();
		} catch (error) {
			if (generation !== this.collabRoomGeneration) return;

			console.error(
				`Não foi possível inicializar a colaboração em ${filePath}:`,
				error,
			);
			this.disconnectCollabRoom();
			new Notice(
				'Não foi possível restaurar o histórico offline desta nota.',
			);
		}
	}

	async loadSettings() {
		this.config = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ObiSyncSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.config);
	}
}
