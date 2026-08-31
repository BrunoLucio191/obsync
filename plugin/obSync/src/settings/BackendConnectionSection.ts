import { Notice, type SettingDefinitionGroup } from 'obsidian';
import { t } from '../i18n/i18n.ts';
import type { SettingsController } from './SettingsController.ts';

/**
 * Renders the "Backend" group of the plugin settings tab: the server URL
 * field. Editable before anyone is authenticated (first-time setup) and
 * thereafter restricted to admins only.
 */
export class BackendConnectionSection {
	private url: string;

	public constructor(
		private readonly controller: SettingsController,
		private readonly refresh: () => void,
	) {
		this.url = controller.config.backendUrl;
	}

	public definition(): SettingDefinitionGroup {
		const canEdit = true;

		return {
			type: 'group',
			heading: t('settings.backend.heading'),
			items: [
				{
					name: t('settings.backend.url'),
					desc: t('settings.backend.urlDesc'),
					render: (setting) => {
						setting.addText((text) => {
							text.setPlaceholder(t('settings.backend.urlPlaceholder'))
								.setValue(this.url)
								.onChange((value) => (this.url = value));
						});

						if (!canEdit) return;

						setting.addButton((button) =>
							button
								.setButtonText(t('common.save'))
								.setCta()
								.onClick(async () => {
									button.setDisabled(true);
									const result = await this.controller.setBackendUrl(this.url);
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
