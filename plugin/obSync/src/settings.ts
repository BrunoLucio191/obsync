import { App, Notice, PluginSettingTab, Setting, SettingGroup } from 'obsidian';
import ObSync from './main.ts';
import type { AuthenticatedUser, UserRole } from './types.ts';

export type ObiSyncSettings = {
	token: string;
	user: AuthenticatedUser | null;
};

export const DEFAULT_SETTINGS: ObiSyncSettings = {
	token: '',
	user: null,
};

export class ObiSyncSettingTab extends PluginSettingTab {
	plugin: ObSync;
	private newUserName = '';
	private newUserEmail = '';
	private newUserPassword = '';
	private newUserRole: UserRole = 'user';
	private readonly nameSaveTimers = new Map<number, number>();
	private readonly nameSaveGenerations = new Map<number, number>();
	private usersCache: AuthenticatedUser[] = [];
	private userSearchQuery = '';
	private usersLoadGeneration = 0;

	constructor(app: App, plugin: ObSync) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('obisync-settings-root');

		const currentUser = this.plugin.config.user;

		if (!currentUser || !this.plugin.config.token) {
			new Setting(containerEl)
				.setName('Usuário desconectado')
				.setDesc(
					'Entre no obisync para acessar a sincronização e as configurações da conta.',
				)
				.addButton((button) =>
					button
						.setButtonText('Entrar')
						.setCta()
						.onClick(async () => {
							button.setDisabled(true);

							try {
								const authenticated =
									await this.plugin.openLogin();

								if (
									authenticated &&
									this.containerEl.isConnected
								) {
									this.display();
								}
							} finally {
								if (button.buttonEl.isConnected) {
									button.setDisabled(false);
								}
							}
						}),
				);

			return;
		}
		//setting groups
		const accountGroup = new SettingGroup(containerEl).setHeading('Conta');

		//acccount settings group
		accountGroup.addSetting((setting) => {
			setting
				.setName('Usuário conectado')
				.setDesc(
					`${currentUser.email} • ${currentUser.role === 'admin' ? 'Administrador' : 'Usuário comum'}`,
				);
		});

		if (currentUser.role === 'admin') {
			this.addEditableNameSetting(
				accountGroup,
				currentUser,
				'Seu nome de exibição',
				'Como administrador, você pode alterar seu próprio nome. A mudança é enviada automaticamente.',
			);
		} else {
			accountGroup.addSetting((setting) => {
				setting
					.setName('Nome de exibição')
					.setDesc(
						`${currentUser.name}. Somente administradores podem alterar nomes de usuários.`,
					);
			});
		}

		if (currentUser.role === 'user') {
			accountGroup.addSetting((setting) => {
				setting
					.setName('Modo privado')
					.setDesc(
						'Suas edições de texto ficam somente neste dispositivo. Você recebe mudanças globais, mas não pode publicá-las no vault compartilhado.',
					);
			});
		}

		accountGroup.addSetting((setting) => {
			setting
				.setName('Sessão')
				.setDesc(
					'Encerra a sessão atual e permite entrar com outra conta.',
				)
				.addButton((button) =>
					button.setButtonText('Sair').onClick(async () => {
						await this.plugin.logout();
						this.display();
					}),
				);
		});

		if (currentUser.role !== 'admin') return;

		const AdministraçãoUsers = new SettingGroup(containerEl).setHeading(
			'Administração de usuários',
		);
		const addNewUser = new SettingGroup(containerEl).setHeading(
			'Adicionar novo usuário',
		);

		AdministraçãoUsers.addSetting((setting) => {
			setting
				.setName('Administração de usuários')
				.setDesc(
					'Somente administradores podem listar contas, criar usuários e alterar nomes, papéis ou status.',
				);
		});
		AdministraçãoUsers.addSetting((setting) => {
			setting
				.setName('Contas cadastradas')
				.setDesc(
					'Nome, papel e status são enviados imediatamente ao backend. A lista mantém uma ordem fixa e mostra até nove usuários por vez.',
				);
		});

		AdministraçãoUsers.addSetting((setting) => {
			setting
				.setName('Buscar usuários')
				.setDesc('Pesquise pelo nome de exibição ou e-mail.')
				.addSearch((search) =>
					search
						.setPlaceholder('Nome ou e-mail')
						.setValue(this.userSearchQuery)
						.onChange((value) => {
							this.userSearchQuery = value;
							this.renderUserRows(
								listViewport,
								resultCountEl,
								false,
							);
						}),
				);

			const resultCountEl = AdministraçãoUsers.listEl.createDiv({
				cls: 'obisync-settings-user-count',
			});
			const listViewport = AdministraçãoUsers.listEl.createDiv({
				cls: 'obisync-settings-user-list',
			});
			void this.loadUsers(listViewport, resultCountEl);
		});

		//Add new user
		addNewUser.addSetting((setting) => {
			setting
				.setName('Nome')
				.setDesc('Nome do usuário no vault.')
				.addText((text) =>
					text

						.setPlaceholder('Nome de exibição')
						.setValue(this.newUserName)
						.onChange((value) => (this.newUserName = value)),
				);
		});
		addNewUser.addSetting((setting) => {
			setting
				.setName('E-mail')
				.setDesc('E-mail usado para fazer login no vault.')
				.addText((text) =>
					text
						.setPlaceholder('usuario@exemplo.com')
						.setValue(this.newUserEmail)
						.onChange((value) => (this.newUserEmail = value)),
				);
		});
		addNewUser.addSetting((setting) => {
			setting
				.setName('Senha inicial')
				.setDesc(
					'Senha para acessar o vault, não esqueça sua senha, não é possível recuperar.',
				)
				.addText((text) => {
					text.inputEl.type = 'password';
					text.setPlaceholder('Mínimo de 6 caracteres')
						.setValue(this.newUserPassword)
						.onChange((value) => (this.newUserPassword = value));
				});
		});
		addNewUser.addSetting((setting) => {
			setting
				.setName('Papel inicial')
				.setDesc('Papel inicial do usuário.')
				.addDropdown((dropdown) =>
					dropdown
						.addOption('user', 'Usuário comum')
						.addOption('admin', 'Administrador')
						.setValue(this.newUserRole)
						.onChange(
							(value) => (this.newUserRole = value as UserRole),
						),
				);
		});
		addNewUser.addSetting((setting) => {
			setting.addButton((button) =>
				button
					.setButtonText('Criar usuário')
					.setCta()
					.onClick(async () => {
						const duplicateName = this.findUserWithSameName(
							this.newUserName,
						);
						if (duplicateName) {
							new Notice(
								`O nome já pertence a ${duplicateName.email}.`,
							);
							return;
						}

						const duplicateEmail = this.findUserWithSameEmail(
							this.newUserEmail,
						);
						if (duplicateEmail) {
							new Notice('Já existe um usuário com esse e-mail.');
							return;
						}

						button.setDisabled(true);

						const result = await this.plugin.createUser({
							name: this.newUserName,
							email: this.newUserEmail,
							password: this.newUserPassword,
							role: this.newUserRole,
						});
						button.setDisabled(false);

						if (!result.ok) {
							new Notice(result.error);
							return;
						}

						this.newUserName = '';
						this.newUserEmail = '';
						this.newUserPassword = '';
						this.newUserRole = 'user';
						new Notice(`Usuário ${result.value.email} criado.`);
						this.display();
					}),
			);
		});
	}

	private addEditableNameSetting(
		group: SettingGroup,
		user: AuthenticatedUser,
		label: string,
		description: string,
	): void {
		group.addSetting((setting) => {
			setting.setName(label).setDesc(description);
			const statusEl = setting.descEl.createDiv({
				cls: 'obisync-setting-save-status',
				text: 'Salvo.',
			});
			setting.addText((text) => {
				text.setValue(user.name)
					.setPlaceholder('Nome de exibição')
					.onChange((value) => {
						this.scheduleUserNameSave(
							user,
							value,
							statusEl,
							text.inputEl,
						);
					});
			});
		});
	}

	private scheduleUserNameSave(
		user: AuthenticatedUser,
		value: string,
		statusEl: HTMLElement,
		inputEl: HTMLInputElement,
		onSaved?: () => void,
	): void {
		const normalizedName = value.trim();
		const generation = (this.nameSaveGenerations.get(user.id) ?? 0) + 1;
		this.nameSaveGenerations.set(user.id, generation);

		const currentTimer = this.nameSaveTimers.get(user.id);
		if (currentTimer !== undefined) {
			window.clearTimeout(currentTimer);
			this.nameSaveTimers.delete(user.id);
		}

		if (normalizedName.length < 2 || normalizedName.length > 64) {
			statusEl.setText('Use entre 2 e 64 caracteres.');
			return;
		}

		if (normalizedName === user.name) {
			statusEl.setText('Salvo.');
			return;
		}

		const duplicateUser = this.findUserWithSameName(
			normalizedName,
			user.id,
		);
		if (duplicateUser) {
			statusEl.setText(`Nome já usado por ${duplicateUser.email}.`);
			return;
		}

		statusEl.setText('Salvando...');
		const timer = window.setTimeout(() => {
			this.nameSaveTimers.delete(user.id);
			void this.persistUserName(
				user,
				normalizedName,
				generation,
				statusEl,
				inputEl,
				onSaved,
			);
		}, 500);
		this.nameSaveTimers.set(user.id, timer);
	}

	private async persistUserName(
		user: AuthenticatedUser,
		name: string,
		generation: number,
		statusEl: HTMLElement,
		inputEl: HTMLInputElement,
		onSaved?: () => void,
	): Promise<void> {
		const previousName = user.name;
		const result = await this.plugin.updateUserName(user.id, name);
		if (
			generation !== this.nameSaveGenerations.get(user.id) ||
			!statusEl.isConnected
		) {
			return;
		}

		if (!result.ok) {
			inputEl.value = previousName;
			statusEl.setText('Erro ao salvar.');
			new Notice(result.error);
			return;
		}

		user.name = result.value.name;
		inputEl.value = result.value.name;
		statusEl.setText('Salvo.');
		onSaved?.();
	}

	private async loadUsers(
		container: HTMLElement,
		resultCountEl: HTMLElement,
	): Promise<void> {
		const generation = ++this.usersLoadGeneration;
		container.empty();
		container.createEl('p', {
			cls: 'obisync-settings-user-list-message',
			text: 'Carregando usuários...',
		});
		resultCountEl.setText('');

		const result = await this.plugin.listUsers();
		if (
			generation !== this.usersLoadGeneration ||
			!container.isConnected ||
			!resultCountEl.isConnected
		) {
			return;
		}

		if (!result.ok) {
			container.empty();
			container.createEl('p', {
				cls: 'obisync-settings-user-list-message',
				text: result.error,
			});
			return;
		}

		this.usersCache = [...result.value].sort(
			(first, second) => first.id - second.id,
		);
		this.debugUserList('users-loaded', {
			order: this.usersCache.map((user) => ({
				id: user.id,
				email: user.email,
				active: user.active,
				role: user.role,
			})),
		});
		this.renderUserRows(container, resultCountEl, false);
	}

	private renderUserRows(
		container: HTMLElement,
		resultCountEl: HTMLElement,
		preserveScroll: boolean,
	): void {
		if (!container.isConnected || !resultCountEl.isConnected) return;

		const previousScrollTop = preserveScroll ? container.scrollTop : 0;
		const normalizedQuery = this.normalizeSearch(this.userSearchQuery);
		const users = this.usersCache.filter((user) => {
			if (!normalizedQuery) return true;
			return (
				this.normalizeSearch(user.name).includes(normalizedQuery) ||
				this.normalizeSearch(user.email).includes(normalizedQuery)
			);
		});

		resultCountEl.setText(
			normalizedQuery
				? `${users.length} de ${this.usersCache.length} usuários encontrados`
				: `${this.usersCache.length} usuários cadastrados`,
		);

		container.empty();
		container.toggleClass('is-scroll-limited', users.length > 9);

		if (users.length === 0) {
			container.createEl('p', {
				cls: 'obisync-settings-user-list-message',
				text: 'Nenhum usuário corresponde à busca.',
			});
			container.scrollTop = 0;
			return;
		}

		const currentUser = this.plugin.config.user;
		const activeAdminCount = this.usersCache.filter(
			(user) => user.active && user.role === 'admin',
		).length;

		for (const user of users) {
			this.renderUserRow(
				container,
				resultCountEl,
				user,
				currentUser,
				activeAdminCount,
			);
		}

		container.scrollTop = Math.min(
			previousScrollTop,
			Math.max(0, container.scrollHeight - container.clientHeight),
		);
		this.debugUserList('users-rendered', {
			query: this.userSearchQuery,
			visibleIds: users.map((user) => user.id),
			scrollTop: container.scrollTop,
		});
	}

	private renderUserRow(
		container: HTMLElement,
		resultCountEl: HTMLElement,
		user: AuthenticatedUser,
		currentUser: AuthenticatedUser | null,
		activeAdminCount: number,
	): void {
		const isCurrent = user.id === currentUser?.id;
		const protectsLastAdmin =
			user.active && user.role === 'admin' && activeAdminCount === 1;
		const setting = new Setting(container).setName(
			`${user.email}${isCurrent ? ' (você)' : ''}`,
		);
		setting.settingEl.addClass('obisync-settings-user-row');
		const statusEl = setting.descEl.createDiv({
			cls: 'obisync-settings-user-status',
		});
		this.updateUserRowDescription(statusEl, user, isCurrent);

		if (!isCurrent && user.role === 'user') {
			const nameStatus = setting.descEl.createDiv({
				cls: 'obisync-setting-save-status',
				text: 'Nome salvo.',
			});
			setting.addText((text) => {
				text.setValue(user.name)
					.setPlaceholder('Nome de exibição')
					.onChange((value) => {
						this.scheduleUserNameSave(
							user,
							value,
							nameStatus,
							text.inputEl,
							() =>
								this.renderUserRows(
									container,
									resultCountEl,
									true,
								),
						);
					});
			});
		}

		const addRoleDropdown = (): void => {
			const previousRole = user.role;
			if (!isCurrent) {
				setting.addDropdown((dropdown) => {
					dropdown
						.addOption('user', 'Usuário comum')
						.addOption('admin', 'Administrador')
						.setValue(previousRole)
						.setDisabled(protectsLastAdmin)
						.onChange(async (value) => {
							dropdown.setDisabled(true);
							const mutation = await this.plugin.updateUserRole(
								user.id,
								value as UserRole,
							);

							if (!mutation.ok) {
								dropdown.setValue(previousRole);
								dropdown.setDisabled(protectsLastAdmin);
								new Notice(mutation.error);
								return;
							}

							this.replaceCachedUser(mutation.value);
							this.debugUserList('role-updated', {
								userId: user.id,
								previousRole,
								role: mutation.value.role,
							});
							new Notice(
								'Papel atualizado. As permissões já foram aplicadas.',
							);
							if (isCurrent) {
								return;
							}
							this.renderUserRows(container, resultCountEl, true);
						});
				});
			}
		};

		if (!isCurrent) {
			// Ordem visual: status -> papel -> exclusão.
			setting.addToggle((toggle) => {
				const previousActive = user.active;
				const statusLocked = protectsLastAdmin;
				toggle
					.setValue(previousActive)
					.setDisabled(statusLocked)
					.onChange(async (active) => {
						toggle.setDisabled(true);
						const mutation = await this.plugin.updateUserStatus(
							user.id,
							active,
						);

						if (!mutation.ok) {
							toggle.setValue(previousActive);
							toggle.setDisabled(statusLocked);
							new Notice(mutation.error);
							return;
						}

						this.replaceCachedUser(mutation.value);
						this.debugUserList('status-updated', {
							userId: user.id,
							previousActive,
							active: mutation.value.active,
							scrollTop: container.scrollTop,
						});
						new Notice(
							active ? 'Usuário ativado.' : 'Usuário desativado.',
						);

						if (mutation.value.role === 'admin') {
							this.renderUserRows(container, resultCountEl, true);
							return;
						}

						user.active = mutation.value.active;
						toggle.setValue(mutation.value.active);
						toggle.setDisabled(false);
						this.updateUserRowDescription(statusEl, user, false);
					});
			});
		}

		addRoleDropdown();

		if (!isCurrent) {
			setting.addButton((button) =>
				button
					.setButtonText('Excluir')
					.setWarning()
					.setDisabled(protectsLastAdmin)
					.onClick(async () => {
						button.setDisabled(true);
						const mutation = await this.plugin.deleteUser(user.id);
						if (!mutation.ok) {
							button.setDisabled(false);
							new Notice(mutation.error);
							return;
						}

						this.usersCache = this.usersCache.filter(
							(cachedUser) => cachedUser.id !== user.id,
						);
						this.debugUserList('user-deleted', { userId: user.id });
						new Notice(`Usuário ${user.email} excluído.`);
						this.renderUserRows(container, resultCountEl, true);
					}),
			);
		}
	}

	private updateUserRowDescription(
		statusEl: HTMLElement,
		user: AuthenticatedUser,
		isCurrent: boolean,
	): void {
		const statusDescription = `${user.role === 'admin' ? 'Administrador' : 'Usuário comum'} • ${user.active ? 'Ativo' : 'Desativado'}`;
		statusEl.setText(
			isCurrent ? `${statusDescription} • Sua conta` : statusDescription,
		);
	}

	private replaceCachedUser(updatedUser: AuthenticatedUser): void {
		const index = this.usersCache.findIndex(
			(user) => user.id === updatedUser.id,
		);
		if (index === -1) return;
		this.usersCache[index] = updatedUser;
	}

	private normalizeUniqueName(value: string): string {
		return value
			.normalize('NFKC')
			.trim()
			.replace(/\s+/g, ' ')
			.toLocaleLowerCase('pt-BR');
	}

	private normalizeUniqueEmail(value: string): string {
		return value.normalize('NFKC').trim().toLocaleLowerCase();
	}

	private findUserWithSameName(
		name: string,
		exceptUserId?: number,
	): AuthenticatedUser | undefined {
		const key = this.normalizeUniqueName(name);
		if (!key) return undefined;
		return this.usersCache.find(
			(user) =>
				user.id !== exceptUserId &&
				this.normalizeUniqueName(user.name) === key,
		);
	}

	private findUserWithSameEmail(
		email: string,
	): AuthenticatedUser | undefined {
		const key = this.normalizeUniqueEmail(email);
		if (!key) return undefined;
		return this.usersCache.find(
			(user) => this.normalizeUniqueEmail(user.email) === key,
		);
	}

	private normalizeSearch(value: string): string {
		return value
			.normalize('NFD')
			.replace(/[\u0300-\u036f]/g, '')
			.trim()
			.toLocaleLowerCase();
	}

	private debugUserList(event: string, data: Record<string, unknown>): void {
		if (window.localStorage.getItem('obisync:settings-debug') !== '1')
			return;
		console.debug(`[ObiSync settings] ${event}`, {
			at: new Date().toISOString(),
			...data,
		});
	}
}
