import { Modal, App } from 'obsidian';

/** Warn the user about a websocket disconnection and start a initial resync automatically*/
export class ResyncWarning extends Modal {
	readonly #reSync;
	constructor(app: App, reSync: () => Promise<void>) {
		super(app);
		this.#reSync = reSync;
	}
	async onOpen(): Promise<void> {
		const { contentEl } = this;
		let contentOfTheMessage =
			'Your network connection was interrupted while you were connected to the server.' +
			' Obsync will automatically start a resync to receive any changes' +
			' missed while you were offline.';
		this.setTitle('Network problems');

		const wrapper = contentEl.createDiv({
			cls: 'obsync-network-warning',
		});
		const networkMessage = wrapper.createEl('p', {
			text: `${contentOfTheMessage}`,
		});
		await this.#reSync();
		networkMessage.setCssStyles('../../styles.css');
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
