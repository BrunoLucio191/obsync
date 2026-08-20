import { Notice, SettingGroup } from 'obsidian';
import type { UserRole } from '../../auth/auth.types.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';

export class CreateUserSection {
	private name = '';
	private email = '';
	private password = '';
	private role: UserRole = 'user';

	public constructor(
		private readonly controller: SettingsController,
		private readonly directory: UserDirectory,
		private readonly refresh: () => void,
	) {}

	public render(container: HTMLElement): void {
		const group = new SettingGroup(container).setHeading(
			'Adicionar novo usuário',
		);

		group.addSetting((setting) => {
			setting
				.setName('Nome')
				.setDesc('Nome do usuário no vault.')
				.addText((text) =>
					text
						.setPlaceholder('Nome de exibição')
						.setValue(this.name)
						.onChange((value) => (this.name = value)),
				);
		});
		group.addSetting((setting) => {
			setting
				.setName('E-mail')
				.setDesc('E-mail usado para fazer login no vault.')
				.addText((text) =>
					text
						.setPlaceholder('usuario@exemplo.com')
						.setValue(this.email)
						.onChange((value) => (this.email = value)),
				);
		});
		group.addSetting((setting) => {
			setting
				.setName('Senha inicial')
				.setDesc(
					'A senha não pode ser recuperada. Guarde-a em um local seguro.',
				)
				.addText((text) => {
					text.inputEl.type = 'password';
					text.setPlaceholder('Mínimo de 6 caracteres')
						.setValue(this.password)
						.onChange((value) => (this.password = value));
				});
		});
		group.addSetting((setting) => {
			setting
				.setName('Papel inicial')
				.setDesc('Papel inicial do usuário.')
				.addDropdown((dropdown) =>
					dropdown
						.addOption('user', 'Usuário comum')
						.addOption('admin', 'Administrador')
						.setValue(this.role)
						.onChange((value) => (this.role = value as UserRole)),
				);
		});
		group.addSetting((setting) => {
			setting.addButton((button) =>
				button
					.setButtonText('Criar usuário')
					.setCta()
					.onClick(async () => {
						const duplicateName = this.directory.findByName(
							this.name,
						);
						if (duplicateName) {
							new Notice(
								`O nome já pertence a ${duplicateName.email}.`,
							);
							return;
						}

						if (this.directory.findByEmail(this.email)) {
							new Notice('Já existe um usuário com esse e-mail.');
							return;
						}

						button.setDisabled(true);
						const result = await this.controller.createUser({
							name: this.name,
							email: this.email,
							password: this.password,
							role: this.role,
						});
						button.setDisabled(false);

						if (!result.ok) {
							new Notice(result.error);
							return;
						}

						this.reset();
						new Notice(`Usuário ${result.value.email} criado.`);
						this.refresh();
					}),
			);
		});
	}

	private reset(): void {
		this.name = '';
		this.email = '';
		this.password = '';
		this.role = 'user';
	}
}
