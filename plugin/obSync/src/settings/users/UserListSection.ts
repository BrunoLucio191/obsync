import {
	Notice,
	type Setting,
	type SettingDefinition,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
} from 'obsidian';
import type {
	AuthenticatedUser,
	UserRole,
} from '../../auth/auth.types.ts';
import { t } from '../../i18n/i18n.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';
import type { UserNameEditor } from './UserNameEditor.ts';

export class UserListSection {
	private loadGeneration = 0;
	private loading = false;
	private loaded = false;
	private loadError: string | null = null;
	private searchQuery = '';

	public constructor(
		private readonly controller: SettingsController,
		private readonly directory: UserDirectory,
		private readonly nameEditor: UserNameEditor,
		private readonly refresh: () => void,
	) {}

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
					desc: this.listStatusDescription(),
					searchable: false,
					render: (setting) => {
						setting
							.setName(t('settings.users.registeredAccounts'))
							.setDesc(this.listStatusDescription());
						if (this.loadError) {
							setting.addButton((button) =>
								button
									.setButtonText(t('common.retry'))
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
				{
					name: t('settings.users.searchAccounts'),
					desc: '',
					searchable: false,
					// Owns its own text input instead of the group-level `search`
					// option, so it stays in this always-visible group, right
					// below "Registered accounts", instead of scrolling away with
					// the list below (see obsync-user-search-setting in styles.css).
					render: (setting) => {
						setting.setClass('obsync-user-search-setting');
						setting.addSearch((search) => {
							search
								.setPlaceholder(t('settings.users.searchPlaceholder'))
								.setValue(this.searchQuery)
								.onChange((value) => {
									this.searchQuery = value;
									this.refresh();
								});
						});
					},
				},
			],
		};

		const userItems: SettingDefinition[] = [];
		if (this.loaded) {
			const currentUser = this.controller.config.user;
			const activeAdminCount = this.directory.activeAdminCount();
			for (const user of this.directory.all()) {
				if (!this.matchesQuery(user, this.searchQuery)) continue;
				userItems.push(
					...this.userDefinitions(user, currentUser, activeAdminCount),
				);
			}
		}

		// Separate group so the rows can scroll on their own, without dragging
		// the always-visible info group (and its search box) along with them.
		const listGroup: SettingDefinitionGroup = {
			type: 'group',
			cls: 'obsync-user-list-scroll',
			visible: () => this.loaded,
			items: userItems,
		};

		return [infoGroup, listGroup];
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
		if (!this.loaded) return t('settings.users.loading');

		return t('settings.users.registeredAccountsDesc', {
			count: this.directory.size,
		});
	}

	// Each user contributes one identity/actions item, plus a dedicated item
	// per editable field (name, password) instead of cramming every control
	// into a single row. Every item still gets its Setting from the
	// framework via `render`, same as the rest of this file.
	private userDefinitions(
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
				this.updateDescription(statusEl, user, isCurrent);

				if (!isCurrent) {
					this.addStatusControl(setting, user, protectsLastAdmin);
					this.addRoleControl(setting, user, protectsLastAdmin);
					this.addDeleteControl(setting, user, protectsLastAdmin);
				}
			},
		};

		if (isCurrent || user.role !== 'user') return [identity];

		// One compact sub-row for both editable fields, instead of a full-height
		// row per field: keeps the extra controls visually attached to the
		// identity row above instead of doubling this account's height.
		const editRow: SettingDefinition = {
			name: `${label} — edit`,
			searchable: false,
			render: (setting) => {
				setting
					.setName(t('settings.users.displayName'))
					.setClass('obsync-settings-user-subrow');
				this.addNameControl(setting, user);
				this.addPasswordResetControl(setting, user);
			},
		};

		return [identity, editRow];
	}

	private addNameControl(
		setting: Setting,
		user: AuthenticatedUser,
	): void {
		const nameStatus = setting.descEl.createDiv({
			cls: 'obsync-setting-save-status',
			text: t('settings.users.nameSaved'),
		});
		setting.addText((text) => {
			text.setValue(user.name)
				.setPlaceholder(t('settings.users.displayName'))
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
				.setPlaceholder(t('settings.users.newPasswordPlaceholder'))
				.onChange((value) => (newPassword = value));
		});
		setting.addButton((button) =>
			button.setButtonText(t('settings.users.resetPassword')).onClick(async () => {
				if (newPassword.length < 6 || newPassword.length > 128) {
					new Notice(t('auth.passwordTooShort'));
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

				new Notice(
					t('userAdmin.passwordReset', { email: result.value.email }),
				);
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
						active
							? t('userAdmin.userActivated')
							: t('userAdmin.userDeactivated'),
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
				.addOption('user', t('settings.users.user'))
				.addOption('admin', t('settings.users.admin'))
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
					new Notice(t('userAdmin.roleUpdated'));
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
				.setButtonText(t('settings.users.delete'))
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
					new Notice(t('userAdmin.userDeleted', { email: user.email }));
					this.refresh();
				}),
		);
	}

	private updateDescription(
		statusEl: HTMLElement,
		user: AuthenticatedUser,
		isCurrent: boolean,
	): void {
		const role =
			user.role === 'admin' ? t('settings.users.admin') : t('settings.users.user');
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

	private matchesQuery(user: AuthenticatedUser, query: string): boolean {
		const normalizedQuery = query.normalize('NFKC').trim().toLowerCase();
		if (!normalizedQuery) return true;

		return [user.email, user.name]
			.join(' ')
			.normalize('NFKC')
			.toLowerCase()
			.includes(normalizedQuery);
	}
}
