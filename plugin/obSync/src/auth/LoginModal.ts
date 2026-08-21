import { App, Modal, Notice, Setting } from 'obsidian';

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
		this.setTitle('Entrar no ObSync');
		this.contentEl.createEl('p', {
			text: 'Informe o e-mail de qualquer conta cadastrada no servidor.',
		});

		new Setting(this.contentEl).setName('E-mail').addText((text) =>
			text
				.setPlaceholder('usuario@exemplo.com')
				.setValue(this.email)
				.onChange((value) => (this.email = value)),
		);

		new Setting(this.contentEl).setName('Senha').addText((text) => {
			text.inputEl.type = 'password';
			text.setPlaceholder('Senha').onChange(
				(value) => (this.password = value),
			);
		});

		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText('Entrar')
				.setCta()
				.onClick(async () => {
					button.setDisabled(true);
					const success = await this.submitLogin(
						this.email,
						this.password,
					);
					button.setDisabled(false);
					if (!success) {
						new Notice('E-mail ou senha inválidos.');
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
