import { Modal, App, Setting } from 'obsidian';

export class ResyncWarning extends Modal {
	readonly #reSync;
	constructor(app: App, reSync: () => Promise<void>) {
		super(app);
		this.#reSync = reSync;
	}
	onOpen(): Promise<void> | void {
		const { contentEl } = this;
		let contentOfTheMessage =
			'Your network connection was interrupted and has since been restored.' +
			' You need to resync to receive any changes missed while offline.';
		this.setTitle('Network problems');

		const wrapper = contentEl.createDiv({
			cls: 'obsync-network-warning',
		});
		const networkMessage = wrapper.createEl('p', {
			text: `${contentOfTheMessage}`,
		});
		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText('Re-sync')
				.setCta()
				.onClick(async () => {
					await this.#reSync();
					this.close();
				}),
		);
		networkMessage.setCssStyles('../../styles.css');
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
