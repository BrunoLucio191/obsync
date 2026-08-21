import {
	App,
	PluginSettingTab,
	Setting,
	type Plugin,
	type SettingDefinitionItem,
} from 'obsidian';
import { AccountSettingsSection } from './AccountSettingsSection.ts';
import type { SettingsController } from './SettingsController.ts';
import { UserManagementSection } from './UserManagementSection.ts';

export class ObiSyncSettingTab extends PluginSettingTab {
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
		return [
			{
				name: 'ObiSync',
				searchable: false,
				render: (setting) => {
					const host = setting.settingEl;
					host.empty();
					host.addClass('obisync-settings-host');
					const container = host.createDiv({
						cls: 'obisync-settings-root',
					});

					const currentUser = this.controller.config.user;
					if (!currentUser || !this.controller.isAuthenticated()) {
						this.renderDisconnectedState(container);
					} else {
						this.account.render(container, currentUser);
						if (currentUser.role === 'admin') {
							this.users.render(container);
						}
					}

					return () => this.users.destroy();
				},
			},
		];
	}

	public hide(): void {
		this.users.destroy();
	}

	private renderDisconnectedState(container: HTMLElement): void {
		new Setting(container)
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
							if (await this.controller.openLogin())
								this.update();
						} finally {
							if (button.buttonEl.isConnected) {
								button.setDisabled(false);
							}
						}
					}),
			);
	}
}
