import {
	App,
	PluginSettingTab,
	type Plugin,
	type SettingDefinitionItem,
} from 'obsidian';
import { t } from '../i18n/i18n.ts';
import { AccountSettingsSection } from './AccountSettingsSection.ts';
import type { SettingsController } from './SettingsController.ts';
import { UserManagementSection } from './UserManagementSection.ts';

export class ObSyncSettingTab extends PluginSettingTab {
	private readonly users: UserManagementSection;
	private readonly account: AccountSettingsSection;

	public constructor(
		app: App,
		plugin: Plugin,
		private readonly controller: SettingsController,
	) {
		super(app, plugin);
		const refresh = (): void => this.update();
		this.users = new UserManagementSection(controller, refresh);
		this.account = new AccountSettingsSection(
			controller,
			this.users,
			refresh,
		);
	}

	public getSettingDefinitions(): SettingDefinitionItem[] {
		const currentUser = this.controller.config.user;
		if (!currentUser || !this.controller.isAuthenticated()) {
			return [this.disconnectedDefinition()];
		}

		const definitions: SettingDefinitionItem[] = [
			this.account.definition(currentUser),
		];
		if (currentUser.role === 'admin') {
			definitions.push(...this.users.definitions());
		}
		return definitions;
	}

	public hide(): void {
		this.users.destroy();
	}

	private disconnectedDefinition(): SettingDefinitionItem {
		return {
			type: 'group',
			heading: t('settings.account.heading'),
			items: [
				{
					name: t('settings.account.disconnectedUser'),
					desc: t('settings.account.disconnectedUserDesc'),
					render: (setting) => {
						setting.addButton((button) =>
							button
								.setButtonText(t('auth.signIn'))
								.setCta()
								.onClick(async () => {
									button.setDisabled(true);
									try {
										if (await this.controller.openLogin()) {
											this.update();
										}
									} finally {
										if (button.buttonEl.isConnected) {
											button.setDisabled(false);
										}
									}
								}),
						);
					},
				},
			],
		};
	}
}
