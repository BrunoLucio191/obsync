import {
	Notice,
	type SettingDefinition,
	type SettingDefinitionGroup,
} from 'obsidian';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import { t } from '../i18n/i18n.ts';
import type { SettingsController } from './SettingsController.ts';
import type { UserManagementSection } from './UserManagementSection.ts';

/**
 * Renders the "Account" group of the plugin settings tab: the connected
 * user's identity/role, their editable display name (or a read-only view for
 * non-admins), the change-password form, and the sign-out action.
 */
export class AccountSettingsSection {
	private currentPassword = '';
	private newPassword = '';

	/** @param users - Shared user-management section, used here to render the editable name field for admins. */
	public constructor(
		private readonly controller: SettingsController,
		private readonly users: UserManagementSection,
		private readonly refresh: () => void,
	) {}

	public definition(currentUser: AuthenticatedUser): SettingDefinitionGroup {
		const role =
			currentUser.role === 'admin'
				? t('settings.account.roleAdmin')
				: t('settings.account.roleUser');
		const items: SettingDefinition[] = [
			{
				name: t('settings.account.connectedUser'),
				desc: t('settings.account.connectedUserDesc', {
					email: currentUser.email,
					role,
				}),
			},
		];

		if (currentUser.role === 'admin') {
			items.push({
				name: t('settings.account.yourDisplayName'),
				desc: t('settings.account.yourDisplayNameDesc'),
				render: (setting) =>
					this.users.renderEditableName(setting, currentUser),
			});
		} else {
			items.push({
				name: t('settings.account.displayName'),
				desc: t('settings.account.displayNameDesc', {
					name: currentUser.name,
				}),
			});
		}

		if (currentUser.role === 'user') {
			items.push({
				name: t('settings.account.privateMode'),
				desc: t('settings.account.privateModeDesc'),
			});
		}

		items.push({
			name: t('settings.account.changePassword'),
			desc: t('settings.account.changePasswordDesc'),
			render: (setting) => {
				setting.addText((text) => {
					text.inputEl.type = 'password';
					text
						.setPlaceholder(t('settings.account.currentPassword'))
						.setValue(this.currentPassword)
						.onChange((value) => (this.currentPassword = value));
				});
				setting.addText((text) => {
					text.inputEl.type = 'password';
					text
						.setPlaceholder(t('settings.account.newPassword'))
						.setValue(this.newPassword)
						.onChange((value) => (this.newPassword = value));
				});
				setting.addButton((button) =>
					button
						.setButtonText(t('settings.account.savePassword'))
						.onClick(async () => {
							if (
								this.newPassword.length < 6 ||
								this.newPassword.length > 128
							) {
								new Notice(t('auth.passwordTooShort'));
								return;
							}

							button.setDisabled(true);
							const result = await this.controller.changePassword(
								this.currentPassword,
								this.newPassword,
							);
							button.setDisabled(false);

							if (!result.ok) {
								new Notice(result.error);
								return;
							}

							this.currentPassword = '';
							this.newPassword = '';
							new Notice(t('settings.account.passwordUpdated'));
							this.refresh();
						}),
				);
			},
		});

		items.push({
			name: t('settings.account.session'),
			desc: t('settings.account.sessionDesc'),
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText(t('common.signOut')).onClick(async () => {
						await this.controller.logout();
						this.refresh();
					}),
				);
			},
		});

		return {
			type: 'group',
			heading: t('settings.account.heading'),
			items,
		};
	}
}
