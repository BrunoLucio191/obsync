import {
	Notice,
	type Setting,
	type SettingDefinition,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
} from 'obsidian';
import type { AuthenticatedUser, UserRole } from '../../auth/auth.types.ts';
import { t } from '../../i18n/i18n.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';
import type { UserNameEditor } from './UserNameEditor.ts';

/** Admin-only account list. Controls that would lock out the last active admin are disabled. */
export class UserListSection {
	#loadGeneration = 0;
	#loading = false;
	#loaded = false;
	#loadError: string | null = null;
	#searchQuery = '';

	readonly #controller: SettingsController;
	readonly #directory: UserDirectory;
	readonly #nameEditor: UserNameEditor;
	readonly #refresh: () => void;

	public constructor(
		controller: SettingsController,
		directory: UserDirectory,
		nameEditor: UserNameEditor,
		refresh: () => void,
	) {
		this.#controller = controller;
		this.#directory = directory;
		this.#nameEditor = nameEditor;
		this.#refresh = refresh;
	}

	/** Also starts the lazy load; `listGroup` stays empty until it finishes. */
	public definitions(): SettingDefinitionItem[] {
		const infoGroup: SettingDefinitionGroup = {
			type: 'group',
			heading: t('settings.users.heading'),
			items: [
				{
					name: t('settings.users.heading'),
					desc: t('settings.users.adminOnlyDesc'),
					searchable: false,
				},
				{
					name: t('settings.users.registeredAccounts'),
					desc: this.#listStatusDescription(),
					searchable: false,
					render: (setting) => {
						setting
							.setName(t('settings.users.registeredAccounts'))
							.setDesc(this.#listStatusDescription());
						if (this.#loadError) {
							setting.addButton((button) =>
								button
									.setButtonText(t('common.retry'))
									.onClick(() => {
										this.#loadError = null;
										this.#ensureLoaded();
										this.#refresh();
									}),
							);
						} else {
							this.#ensureLoaded();
						}
					},
				},
				{
					name: t('settings.users.searchAccounts'),
					desc: '',
					searchable: false,
					// Its own input instead of the group `search` option, so it doesn't scroll away with the list
					render: (setting) => {
						setting.setClass('obsync-user-search-setting');
						setting.addSearch((search) => {
							search
								.setPlaceholder(
									t('settings.users.searchPlaceholder'),
								)
								.setValue(this.#searchQuery)
								.onChange((value) => {
									this.#searchQuery = value;
									this.#refresh();
								});
						});
					},
				},
			],
		};

		const userItems: SettingDefinition[] = [];
		if (this.#loaded) {
			const currentUser = this.#controller.config.user;
			const activeAdminCount = this.#directory.activeAdminCount();
			for (const user of this.#directory.all()) {
				if (!this.#matchesQuery(user, this.#searchQuery)) continue;
				userItems.push(
					...this.#userDefinitions(
						user,
						currentUser,
						activeAdminCount,
					),
				);
			}
		}

		// Separate group so the rows scroll without dragging the search box along
		const listGroup: SettingDefinitionGroup = {
			type: 'group',
			cls: 'obsync-user-list-scroll',
			visible: () => this.#loaded,
			items: userItems,
		};

		return [infoGroup, listGroup];
	}

	public destroy(): void {
		this.#loadGeneration += 1;
		this.#loading = false;
		this.#loaded = false;
		this.#loadError = null;
	}

	#ensureLoaded(): void {
		if (this.#loading || this.#loaded || this.#loadError) return;
		void this.#load();
	}

	/** The generation counter keeps a stale response (e.g. after `destroy()`) from overwriting newer state. */
	async #load(): Promise<void> {
		const generation = ++this.#loadGeneration;
		this.#loading = true;
		this.#loadError = null;

		const result = await this.#controller.listUsers();
		if (generation !== this.#loadGeneration) return;

		this.#loading = false;
		if (result.ok == false) {
			this.#loadError = result.error;
			this.#refresh();
			return;
		}

		this.#directory.replaceAll(result.value);
		this.#loaded = true;
		this.#refresh();
	}

	#listStatusDescription(): string {
		if (this.#loadError) return this.#loadError;
		if (!this.#loaded) return t('settings.users.loading');

		return t('settings.users.registeredAccountsDesc', {
			count: this.#directory.size,
		});
	}

	#userDefinitions(
		user: AuthenticatedUser,
		currentUser: AuthenticatedUser | null,
		activeAdminCount: number,
	): SettingDefinition[] {
		const isCurrent = user.id === currentUser?.id;
		const protectsLastAdmin =
			user.active && user.role === 'admin' && activeAdminCount === 1;
		const label = `${user.email}${isCurrent ? t('settings.users.you') : ''}`;

		const identity: SettingDefinition = {
			name: label,
			aliases: [user.email, user.name],
			render: (setting) => {
				setting.setName(label).setClass('obsync-settings-user-row');
				const statusEl = setting.descEl.createDiv({
					cls: 'obsync-settings-user-status',
				});
				this.#updateDescription(statusEl, user, isCurrent);

				if (!isCurrent) {
					this.#addStatusControl(setting, user, protectsLastAdmin);
					this.#addRoleControl(setting, user, protectsLastAdmin);
					this.#addDeleteControl(setting, user, protectsLastAdmin);
				}
			},
		};

		if (isCurrent || user.role !== 'user') return [identity];

		// One compact sub-row for both fields, so they stay attached to the identity row above
		const editRow: SettingDefinition = {
			name: `${label} — edit`,
			searchable: false,
			render: (setting) => {
				setting
					.setName(t('settings.users.displayName'))
					.setClass('obsync-settings-user-subrow');
				this.#addNameControl(setting, user);
				this.#addPasswordResetControl(setting, user);
			},
		};

		return [identity, editRow];
	}

	#addNameControl(setting: Setting, user: AuthenticatedUser): void {
		const nameStatus = setting.descEl.createDiv({
			cls: 'obsync-setting-save-status',
			text: t('settings.users.nameSaved'),
		});
		setting.addText((text) => {
			text.setValue(user.name)
				.setPlaceholder(t('settings.users.displayName'))
				.onChange((value) => {
					this.#nameEditor.scheduleSave(
						user,
						value,
						nameStatus,
						text.inputEl,
						this.#refresh,
					);
				});
		});
	}

	#addPasswordResetControl(setting: Setting, user: AuthenticatedUser): void {
		let newPassword = '';
		setting.addText((text) => {
			text.inputEl.type = 'password';
			text.setPlaceholder(
				t('settings.users.newPasswordPlaceholder'),
			).onChange((value) => (newPassword = value));
		});
		setting.addButton((button) =>
			button
				.setButtonText(t('settings.users.resetPassword'))
				.onClick(async () => {
					if (newPassword.length < 6 || newPassword.length > 128) {
						new Notice(t('auth.passwordTooShort'));
						return;
					}

					button.setDisabled(true);
					const result = await this.#controller.resetUserPassword(
						user.id,
						newPassword,
					);
					button.setDisabled(false);

					if (result.ok == false) {
						new Notice(result.error);
						return;
					}

					new Notice(
						t('userAdmin.passwordReset', {
							email: result.value.email,
						}),
					);
					this.#refresh();
				}),
		);
	}

	#addStatusControl(
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
					const mutation = await this.#controller.updateUserStatus(
						user.id,
						active,
					);
					if (mutation.ok == false) {
						toggle.setValue(previousActive);
						toggle.setDisabled(protectsLastAdmin);
						new Notice(mutation.error);
						return;
					}

					this.#directory.replace(mutation.value);
					new Notice(
						active
							? t('userAdmin.userActivated')
							: t('userAdmin.userDeactivated'),
					);
					this.#refresh();
				});
		});
	}

	#addRoleControl(
		setting: Setting,
		user: AuthenticatedUser,
		protectsLastAdmin: boolean,
	): void {
		const previousRole = user.role;
		setting.addDropdown((dropdown) => {
			dropdown
				.addOption('user', t('settings.users.user'))
				.addOption('admin', t('settings.users.admin'))
				.setValue(previousRole)
				.setDisabled(protectsLastAdmin)
				.onChange(async (value) => {
					dropdown.setDisabled(true);
					const mutation = await this.#controller.updateUserRole(
						user.id,
						value as UserRole,
					);
					if (mutation.ok == false) {
						dropdown.setValue(previousRole);
						dropdown.setDisabled(protectsLastAdmin);
						new Notice(mutation.error);
						return;
					}

					this.#directory.replace(mutation.value);
					new Notice(t('userAdmin.roleUpdated'));
					this.#refresh();
				});
		});
	}

	#addDeleteControl(
		setting: Setting,
		user: AuthenticatedUser,
		protectsLastAdmin: boolean,
	): void {
		setting.addButton((button) =>
			button
				.setButtonText(t('settings.users.delete'))
				.setDestructive()
				.setDisabled(protectsLastAdmin)
				.onClick(async () => {
					button.setDisabled(true);
					const mutation = await this.#controller.deleteUser(user.id);
					if (mutation.ok == false) {
						button.setDisabled(false);
						new Notice(mutation.error);
						return;
					}

					this.#directory.remove(user.id);
					new Notice(
						t('userAdmin.userDeleted', { email: user.email }),
					);
					this.#refresh();
				}),
		);
	}

	#updateDescription(
		statusEl: HTMLElement,
		user: AuthenticatedUser,
		isCurrent: boolean,
	): void {
		const role =
			user.role === 'admin'
				? t('settings.users.admin')
				: t('settings.users.user');
		const status = user.active
			? t('settings.users.active')
			: t('settings.users.inactive');
		const description = `${role} • ${status}`;
		statusEl.setText(
			isCurrent
				? `${description} • ${t('settings.users.yourAccount')}`
				: description,
		);
	}

	#matchesQuery(user: AuthenticatedUser, query: string): boolean {
		const normalizedQuery = query.normalize('NFKC').trim().toLowerCase();
		if (!normalizedQuery) return true;

		return [user.email, user.name]
			.join(' ')
			.normalize('NFKC')
			.toLowerCase()
			.includes(normalizedQuery);
	}
}
