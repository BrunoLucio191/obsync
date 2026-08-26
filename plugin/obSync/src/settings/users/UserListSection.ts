import {
	Notice,
	type Setting,
	type SettingDefinition,
	type SettingDefinitionGroup,
} from 'obsidian';
import type {
	AuthenticatedUser,
	UserRole,
} from '../../auth/auth.types.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';
import type { UserNameEditor } from './UserNameEditor.ts';

export class UserListSection {
	private loadGeneration = 0;
	private loading = false;
	private loaded = false;
	private loadError: string | null = null;

	public constructor(
		private readonly controller: SettingsController,
		private readonly directory: UserDirectory,
		private readonly nameEditor: UserNameEditor,
		private readonly refresh: () => void,
	) {}

	public definition(): SettingDefinitionGroup {
		const items: SettingDefinition[] = [
			{
				name: 'Administração de usuários',
				desc: 'Somente administradores podem listar contas, criar usuários e alterar nomes, senhas, papéis ou status.',
				searchable: false,
			},
			{
				name: 'Contas cadastradas',
				desc: this.listStatusDescription(),
				searchable: false,
				render: (setting) => {
					setting
						.setName('Contas cadastradas')
						.setDesc(this.listStatusDescription());
					if (this.loadError) {
						setting.addButton((button) =>
							button
								.setButtonText('Tentar novamente')
								.onClick(() => {
									this.loadError = null;
									this.ensureLoaded();
									this.refresh();
								}),
						);
					} else {
						this.ensureLoaded();
					}
				},
			},
		];

		if (this.loaded) {
			const currentUser = this.controller.config.user;
			const activeAdminCount = this.directory.activeAdminCount();
			for (const user of this.directory.all()) {
				items.push(
					this.userDefinition(user, currentUser, activeAdminCount),
				);
			}
		}

		return {
			type: 'group',
			heading: 'Administração de usuários',
			cls: 'obsync-user-list-scroll',
			search: {
				placeholder: 'Nome ou e-mail',
				match: (definition, query) =>
					this.matchesSearch(definition, query),
			},
			items,
		};
	}

	public destroy(): void {
		this.loadGeneration += 1;
		this.loading = false;
		this.loaded = false;
		this.loadError = null;
	}

	private ensureLoaded(): void {
		if (this.loading || this.loaded || this.loadError) return;
		void this.load();
	}

	private async load(): Promise<void> {
		const generation = ++this.loadGeneration;
		this.loading = true;
		this.loadError = null;

		const result = await this.controller.listUsers();
		if (generation !== this.loadGeneration) return;

		this.loading = false;
		if (!result.ok) {
			this.loadError = result.error;
			this.refresh();
			return;
		}

		this.directory.replaceAll(result.value);
		this.loaded = true;
		this.refresh();
	}

	private listStatusDescription(): string {
		if (this.loadError) return this.loadError;
		if (!this.loaded) return 'Carregando usuários...';

		return `${this.directory.size} usuários cadastrados. Use a busca acima para filtrar por nome ou e-mail.`;
	}

	private userDefinition(
		user: AuthenticatedUser,
		currentUser: AuthenticatedUser | null,
		activeAdminCount: number,
	): SettingDefinition {
		const isCurrent = user.id === currentUser?.id;
		return {
			name: `${user.email}${isCurrent ? ' (você)' : ''}`,
			aliases: [user.email, user.name],
			render: (setting) =>
				this.renderUser(setting, user, isCurrent, activeAdminCount),
		};
	}

	private renderUser(
		setting: Setting,
		user: AuthenticatedUser,
		isCurrent: boolean,
		activeAdminCount: number,
	): void {
		const protectsLastAdmin =
			user.active && user.role === 'admin' && activeAdminCount === 1;
		setting
			.setName(`${user.email}${isCurrent ? ' (você)' : ''}`)
			.setClass('obsync-settings-user-row');
		const statusEl = setting.descEl.createDiv({
			cls: 'obsync-settings-user-status',
		});
		this.updateDescription(statusEl, user, isCurrent);

		if (!isCurrent && user.role === 'user') {
			this.addNameControl(setting, user);
			this.addPasswordResetControl(setting, user);
		}
		if (!isCurrent) {
			this.addStatusControl(setting, user, protectsLastAdmin);
			this.addRoleControl(setting, user, protectsLastAdmin);
			this.addDeleteControl(setting, user, protectsLastAdmin);
		}
	}

	private addNameControl(
		setting: Setting,
		user: AuthenticatedUser,
	): void {
		const nameStatus = setting.descEl.createDiv({
			cls: 'obsync-setting-save-status',
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
						this.refresh,
					);
				});
		});
	}

	private addPasswordResetControl(
		setting: Setting,
		user: AuthenticatedUser,
	): void {
		let newPassword = '';
		setting.addText((text) => {
			text.inputEl.type = 'password';
			text
				.setPlaceholder('Nova senha (6-128 caracteres)')
				.onChange((value) => (newPassword = value));
		});
		setting.addButton((button) =>
			button.setButtonText('Redefinir senha').onClick(async () => {
				if (newPassword.length < 6 || newPassword.length > 128) {
					new Notice(
						'A nova senha precisa ter entre 6 e 128 caracteres.',
					);
					return;
				}

				button.setDisabled(true);
				const result = await this.controller.resetUserPassword(
					user.id,
					newPassword,
				);
				button.setDisabled(false);

				if (!result.ok) {
					new Notice(result.error);
					return;
				}

				new Notice(`Senha de ${result.value.email} redefinida.`);
				this.refresh();
			}),
		);
	}

	private addStatusControl(
		setting: Setting,
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
					this.refresh();
				});
		});
	}

	private addRoleControl(
		setting: Setting,
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
					this.refresh();
				});
		});
	}

	private addDeleteControl(
		setting: Setting,
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
					this.refresh();
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

	private matchesSearch(
		definition: SettingDefinition,
		query: string,
	): boolean {
		const normalizedQuery = query.normalize('NFKC').trim().toLowerCase();
		if (!normalizedQuery) return true;

		const description =
			typeof definition.desc === 'string' ? definition.desc : '';
		return [definition.name, description, ...(definition.aliases ?? [])]
			.join(' ')
			.normalize('NFKC')
			.toLowerCase()
			.includes(normalizedQuery);
	}
}
