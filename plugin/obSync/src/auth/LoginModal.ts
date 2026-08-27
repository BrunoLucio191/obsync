import { App, Modal, Notice, Setting } from 'obsidian';
import { t } from '../i18n/i18n.ts';

/**
 * Obsidian modal that collects an e-mail and password and delegates the
 * actual login request to a caller-supplied callback, reporting back
 * whether the user ended up authenticated when the modal closes.
 */
export class LoginModal extends Modal {
	private email = '';
	private password = '';
	private authenticated = false;

	/**
	 * @param app - The Obsidian app instance, forwarded to `Modal`.
	 * @param submitLogin - Called with the entered credentials when the user clicks "Sign in"; should return whether login succeeded.
	 * @param onFinished - Called once, when the modal closes, with whether authentication succeeded (by login or otherwise).
	 */
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

	/** Builds the modal's e-mail/password form and wires up the sign-in button. */
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

	/** Clears the modal's DOM and reports the final authentication outcome to {@link onFinished}. */
	onClose(): void {
		this.contentEl.empty();
		this.onFinished(this.authenticated);
	}
}
