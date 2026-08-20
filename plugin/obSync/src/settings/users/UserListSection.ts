import { Notice, Setting, SettingGroup } from 'obsidian';
import type {
	AuthenticatedUser,
	UserRole,
} from '../../auth/auth.types.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';
import type { UserNameEditor } from './UserNameEditor.ts';

export class UserListSection {
	private searchQuery = '';
	private loadGeneration = 0;

	public constructor(
		private readonly controller: SettingsController,
		private readonly directory: UserDirectory,
		private readonly nameEditor: UserNameEditor,
	) {}

	public render(container: HTMLElement): void {
		const group = new SettingGroup(container).setHeading(
			'Administração de usuários',
		);

		group.addSetting((setting) => {
			setting
				.setName('Administração de usuários')
				.setDesc(
					'Somente administradores podem listar contas, criar usuários e alterar nomes, papéis ou status.',
				);
		});
		group.addSetting((setting) => {
			setting
				.setName('Contas cadastradas')
				.setDesc(
					'Nome, papel e status são enviados imediatamente ao backend. A lista mantém uma ordem fixa e mostra até nove usuários por vez.',
				);
		});
		group.addSetting((setting) => {
			setting
				.setName('Buscar usuários')
				.setDesc('Pesquise pelo nome de exibição ou e-mail.')
				.addSearch((search) =>
					search
						.setPlaceholder('Nome ou e-mail')
						.setValue(this.searchQuery)
						.onChange((value) => {
							this.searchQuery = value;
							this.renderRows(viewport, resultCountEl, false);
						}),
				);

			const resultCountEl = group.listEl.createDiv({
				cls: 'obisync-settings-user-count',
			});
			const viewport = group.listEl.createDiv({
				cls: 'obisync-settings-user-list',
			});
			void this.load(viewport, resultCountEl);
		});
	}

	public destroy(): void {
		this.loadGeneration += 1;
	}

	private async load(
		container: HTMLElement,
		resultCountEl: HTMLElement,
	): Promise<void> {
		const generation = ++this.loadGeneration;
		container.empty();
		container.createEl('p', {
			cls: 'obisync-settings-user-list-message',
			text: 'Carregando usuários...',
		});
		resultCountEl.setText('');

		const result = await this.controller.listUsers();
		if (
			generation !== this.loadGeneration ||
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

		this.directory.replaceAll(result.value);
		this.debug('users-loaded', {
			order: this.directory.all().map((user) => ({
				id: user.id,
				email: user.email,
				active: user.active,
				role: user.role,
			})),
		});
		this.renderRows(container, resultCountEl, false);
	}

	private renderRows(
		container: HTMLElement,
		resultCountEl: HTMLElement,
		preserveScroll: boolean,
	): void {
		if (!container.isConnected || !resultCountEl.isConnected) return;

		const previousScrollTop = preserveScroll ? container.scrollTop : 0;
		const users = this.directory.search(this.searchQuery);
		const hasQuery = this.searchQuery.trim().length > 0;

		resultCountEl.setText(
			hasQuery
				? `${users.length} de ${this.directory.size} usuários encontrados`
				: `${this.directory.size} usuários cadastrados`,
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

		const currentUser = this.controller.config.user;
		const activeAdminCount = this.directory.activeAdminCount();
		for (const user of users) {
			this.renderRow(
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
		this.debug('users-rendered', {
			query: this.searchQuery,
			visibleIds: users.map((user) => user.id),
			scrollTop: container.scrollTop,
		});
	}

	private renderRow(
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
		this.updateDescription(statusEl, user, isCurrent);

		if (!isCurrent && user.role === 'user') {
			this.addNameControl(setting, container, resultCountEl, user);
		}
		if (!isCurrent) {
			this.addStatusControl(
				setting,
				container,
				resultCountEl,
				statusEl,
				user,
				protectsLastAdmin,
			);
			this.addRoleControl(
				setting,
				container,
				resultCountEl,
				user,
				protectsLastAdmin,
			);
			this.addDeleteControl(
				setting,
				container,
				resultCountEl,
				user,
				protectsLastAdmin,
			);
		}
	}

	private addNameControl(
		setting: Setting,
		container: HTMLElement,
		resultCountEl: HTMLElement,
		user: AuthenticatedUser,
	): void {
		const nameStatus = setting.descEl.createDiv({
			cls: 'obisync-setting-save-status',
			text: 'Nome salvo.',
		});
		setting.addText((text) => {
			text.setValue(user.name)
				.setPlaceholder('Nome de exibição')
				.onChange((value) => {
					this.nameEditor.scheduleSave(
						user,
						value,
						nameStatus,
						text.inputEl,
						() => this.renderRows(container, resultCountEl, true),
					);
				});
		});
	}

	private addStatusControl(
		setting: Setting,
		container: HTMLElement,
		resultCountEl: HTMLElement,
		statusEl: HTMLElement,
		user: AuthenticatedUser,
		protectsLastAdmin: boolean,
	): void {
		setting.addToggle((toggle) => {
			const previousActive = user.active;
			toggle
				.setValue(previousActive)
				.setDisabled(protectsLastAdmin)
				.onChange(async (active) => {
					toggle.setDisabled(true);
					const mutation = await this.controller.updateUserStatus(
						user.id,
						active,
					);

					if (!mutation.ok) {
						toggle.setValue(previousActive);
						toggle.setDisabled(protectsLastAdmin);
						new Notice(mutation.error);
						return;
					}

					this.directory.replace(mutation.value);
					new Notice(
						active ? 'Usuário ativado.' : 'Usuário desativado.',
					);

					if (mutation.value.role === 'admin') {
						this.renderRows(container, resultCountEl, true);
						return;
					}

					user.active = mutation.value.active;
					toggle.setValue(mutation.value.active);
					toggle.setDisabled(false);
					this.updateDescription(statusEl, user, false);
				});
		});
	}

	private addRoleControl(
		setting: Setting,
		container: HTMLElement,
		resultCountEl: HTMLElement,
		user: AuthenticatedUser,
		protectsLastAdmin: boolean,
	): void {
		const previousRole = user.role;
		setting.addDropdown((dropdown) => {
			dropdown
				.addOption('user', 'Usuário comum')
				.addOption('admin', 'Administrador')
				.setValue(previousRole)
				.setDisabled(protectsLastAdmin)
				.onChange(async (value) => {
					dropdown.setDisabled(true);
					const mutation = await this.controller.updateUserRole(
						user.id,
						value as UserRole,
					);

					if (!mutation.ok) {
						dropdown.setValue(previousRole);
						dropdown.setDisabled(protectsLastAdmin);
						new Notice(mutation.error);
						return;
					}

					this.directory.replace(mutation.value);
					new Notice(
						'Papel atualizado. As permissões já foram aplicadas.',
					);
					this.renderRows(container, resultCountEl, true);
				});
		});
	}

	private addDeleteControl(
		setting: Setting,
		container: HTMLElement,
		resultCountEl: HTMLElement,
		user: AuthenticatedUser,
		protectsLastAdmin: boolean,
	): void {
		setting.addButton((button) =>
			button
				.setButtonText('Excluir')
				.setDestructive()
				.setDisabled(protectsLastAdmin)
				.onClick(async () => {
					button.setDisabled(true);
					const mutation = await this.controller.deleteUser(user.id);
					if (!mutation.ok) {
						button.setDisabled(false);
						new Notice(mutation.error);
						return;
					}

					this.directory.remove(user.id);
					new Notice(`Usuário ${user.email} excluído.`);
					this.renderRows(container, resultCountEl, true);
				}),
		);
	}

	private updateDescription(
		statusEl: HTMLElement,
		user: AuthenticatedUser,
		isCurrent: boolean,
	): void {
		const role = user.role === 'admin' ? 'Administrador' : 'Usuário comum';
		const status = user.active ? 'Ativo' : 'Desativado';
		const description = `${role} • ${status}`;
		statusEl.setText(
			isCurrent ? `${description} • Sua conta` : description,
		);
	}

	private debug(event: string, data: Record<string, unknown>): void {
		if (window.localStorage.getItem('obisync:settings-debug') !== '1') {
			return;
		}
		console.debug(`[ObiSync settings] ${event}`, {
			at: new Date().toISOString(),
			...data,
		});
	}
}
