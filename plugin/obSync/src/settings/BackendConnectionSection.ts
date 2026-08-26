import { Notice, type SettingDefinitionGroup } from 'obsidian';
import { t } from '../i18n/i18n.ts';
import type { SettingsController } from './SettingsController.ts';

export class BackendConnectionSection {
	private url: string;

	public constructor(
		private readonly controller: SettingsController,
		private readonly refresh: () => void,
	) {
		this.url = controller.config.backendUrl;
	}

	public definition(): SettingDefinitionGroup {
		const currentUser = this.controller.config.user;
		// Nobody is authenticated yet on first-time setup, so editing must stay
		// open until then; once a role is known, only an admin may repoint the
		// client at a different server.
		const canEdit = !currentUser || currentUser.role === 'admin';

		return {
			type: 'group',
			heading: t('settings.backend.heading'),
			items: [
				{
					name: t('settings.backend.url'),
					desc: canEdit
						? t('settings.backend.urlDesc')
						: t('settings.backend.urlDescReadOnly'),
					render: (setting) => {
						setting.addText((text) => {
							text
								.setPlaceholder(t('settings.backend.urlPlaceholder'))
								.setValue(this.url)
								.setDisabled(!canEdit)
								.onChange((value) => (this.url = value));
						});

						if (!canEdit) return;

						setting.addButton((button) =>
							button
								.setButtonText(t('common.save'))
								.setCta()
								.onClick(async () => {
									button.setDisabled(true);
									const result = await this.controller.setBackendUrl(
										this.url,
									);
									button.setDisabled(false);

									if (!result.ok) {
										new Notice(result.error);
										return;
									}

									new Notice(t('settings.backend.saved'));
									this.refresh();
								}),
						);
					},
				},
			],
		};
	}
}
