import { Modal, App } from 'obsidian';
import { t } from '../i18n/i18n.ts';
/** Warn the user about a websocket disconnection and start a initial resync automatically*/
export class ResyncWarning extends Modal {
	readonly #reSync;
	constructor(app: App, reSync: () => Promise<void>) {
		super(app);
		this.#reSync = reSync;
	}
	async onOpen(): Promise<void> {
		const { contentEl } = this;
		this.setTitle(t(`sync.networkProblems`));

		const wrapper = contentEl.createDiv({
			cls: 'obsync-network-warning',
		});
		wrapper.createEl('p', {
			text: t(`sync.websocketDisconnetionFromInternet`),
		});
		await this.#reSync();
	}
	onClose(): void {
		this.contentEl.empty();
	}
}
