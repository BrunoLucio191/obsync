import {
	App,
	PluginSettingTab,
	SettingDefinitionGroup,
	SettingDefinitionPage,
	type Plugin,
	type SettingDefinitionItem,
} from 'obsidian';
import { isApiEndpointConfigured } from '../config/ApiConfig.ts';
import { t } from '../i18n/i18n.ts';
import { AccountSettingsSection } from './AccountSettingsSection.ts';
import { BackendConnectionSection } from './BackendConnectionSection.ts';
import { UserManagementSection } from './UserManagementSection.ts';
import ObSync from '../main.ts';
/** Receives the other fields for settings and combina everything together*/
export class ObSyncSettingTab extends PluginSettingTab {
	readonly #backend: BackendConnectionSection;
	readonly #users: UserManagementSection;
	readonly #account: AccountSettingsSection;
	readonly #controller: ObSync;

	public constructor(app: App, plugin: Plugin & ObSync) {
		super(app, plugin);
		this.#controller = plugin;
		const refresh = () => this.update();
		this.#backend = new BackendConnectionSection(plugin, refresh);
		this.#users = new UserManagementSection(plugin, refresh);
		this.#account = new AccountSettingsSection(
			plugin,
			this.#users,
			refresh,
		);
	}
	public getAllConfiguration(): SettingDefinitionItem[] {
		const backendSection = this.#backend.definition();
		const configured = isApiEndpointConfigured();
		const currentUser = configured ? this.#controller.config.user : null;
		const authenticated =
			configured && !!currentUser && this.#controller.isAuthenticated();

		let accountSection: SettingDefinitionGroup;

		if (!configured) {
			accountSection = { type: 'group', visible: false };
		} else if (!authenticated || !currentUser) {
			accountSection = this.#disconnectedDefinition();
		} else {
			accountSection = this.#account.definition(currentUser);
		}
		const usersPage: SettingDefinitionPage = {
			type: 'page',
			name: t('settings.users.heading'),
			visible: authenticated && currentUser?.role === 'admin',
			items: this.#users.definitions(),
		};
		return [backendSection, accountSection, usersPage];
	}

	public getSettingDefinitions() {
		return this.getAllConfiguration();
	}

	public hide(): void {
		this.#users.destroy();
	}

	#disconnectedDefinition(): SettingDefinitionGroup {
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
										if (await this.#controller.openLogin())
											this.update();
									} finally {
										button.setDisabled(false);
									}
								}),
						);
					},
				},
			],
		};
	}
}
