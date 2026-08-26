import { App, Modal, Notice, Setting } from 'obsidian';
import { t } from '../i18n/i18n.ts';

export class LoginModal extends Modal {
	private email = '';
	private password = '';
	private authenticated = false;

	constructor(
		app: App,
		private readonly submitLogin: (
			email: string,
			password: string,
		) => Promise<boolean>,
		private readonly onFinished: (authenticated: boolean) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(t('auth.loginTitle'));
		this.contentEl.createEl('p', {
			text: t('auth.loginPrompt'),
		});

		new Setting(this.contentEl).setName(t('auth.email')).addText((text) =>
			text
				.setPlaceholder(t('auth.emailPlaceholder'))
				.setValue(this.email)
				.onChange((value) => (this.email = value)),
		);

		new Setting(this.contentEl).setName(t('auth.password')).addText((text) => {
			text.inputEl.type = 'password';
			text.setPlaceholder(t('auth.password')).onChange(
				(value) => (this.password = value),
			);
		});

		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText(t('auth.signIn'))
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					const success = await this.submitLogin(
						this.email,
						this.password,
					);
					button.setDisabled(false);
					if (!success) {
						new Notice(t('auth.invalidCredentials'));
						return;
					}
					this.authenticated = true;
					this.close();
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onFinished(this.authenticated);
	}
}
