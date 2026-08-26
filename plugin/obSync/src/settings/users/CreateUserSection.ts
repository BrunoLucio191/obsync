import { Notice, type SettingDefinitionGroup } from 'obsidian';
import type { UserRole } from '../../auth/auth.types.ts';
import { t } from '../../i18n/i18n.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';

export class CreateUserSection {
	private name = '';
	private email = '';
	private password = '';
	private role: UserRole = 'user';

	public constructor(
		private readonly controller: SettingsController,
		private readonly directory: UserDirectory,
		private readonly refresh: () => void,
	) {}

	public definition(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: t('settings.users.addUser'),
			items: [
				{
					name: t('settings.users.name'),
					desc: t('settings.users.displayName'),
					render: (setting) =>
						setting.addText((text) =>
							text
								.setPlaceholder(t('settings.users.namePlaceholder'))
								.setValue(this.name)
								.onChange((value) => (this.name = value)),
						),
				},
				{
					name: t('auth.email'),
					desc: t('auth.email'),
					render: (setting) =>
						setting.addText((text) =>
							text
								.setPlaceholder(t('settings.users.emailPlaceholder'))
								.setValue(this.email)
								.onChange((value) => (this.email = value)),
						),
				},
				{
					name: t('settings.users.initialPassword'),
					desc: t('settings.users.initialPasswordDesc'),
					render: (setting) => {
						setting.addText((text) => {
							text.inputEl.type = 'password';
							text.setPlaceholder(t('settings.users.minCharsPlaceholder'))
								.setValue(this.password)
								.onChange((value) => (this.password = value));
						});
					},
				},
				{
					name: t('settings.users.initialRole'),
					desc: t('settings.users.initialRoleDesc'),
					render: (setting) =>
						setting.addDropdown((dropdown) =>
							dropdown
								.addOption('user', t('settings.users.user'))
								.addOption('admin', t('settings.users.admin'))
								.setValue(this.role)
								.onChange(
									(value) => (this.role = value as UserRole),
								),
						),
				},
				{
					name: t('settings.users.createUser'),
					desc: t('settings.users.createUserDesc'),
					searchable: false,
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText(t('settings.users.createUser'))
								.setCta()
								.onClick(async () => {
									const duplicateName = this.directory.findByName(
										this.name,
									);
									if (duplicateName) {
										new Notice(
											t('userAdmin.nameAlreadyUsedBy', {
												email: duplicateName.email,
											}),
										);
										return;
									}

									if (this.directory.findByEmail(this.email)) {
										new Notice(
											t('userAdmin.emailAlreadyExists'),
										);
										return;
									}

									button.setDisabled(true);
									const result = await this.controller.createUser({
										name: this.name,
										email: this.email,
										password: this.password,
										role: this.role,
									});
									button.setDisabled(false);

									if (!result.ok) {
										new Notice(result.error);
										return;
									}

									this.reset();
									new Notice(
										t('userAdmin.userCreated', {
											email: result.value.email,
										}),
									);
									this.refresh();
								}),
						);
					},
				},
			],
		};
	}

	private reset(): void {
		this.name = '';
		this.email = '';
		this.password = '';
		this.role = 'user';
	}
}
