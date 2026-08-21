import { Notice, type SettingDefinitionGroup } from 'obsidian';
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

	public definition(): SettingDefinitionGroup {
		return {
			type: 'group',
			heading: 'Adicionar novo usuário',
			items: [
				{
					name: 'Nome',
					desc: 'Nome do usuário no vault.',
					render: (setting) =>
						setting.addText((text) =>
							text
								.setPlaceholder('Nome de exibição')
								.setValue(this.name)
								.onChange((value) => (this.name = value)),
						),
				},
				{
					name: 'E-mail',
					desc: 'E-mail usado para fazer login no vault.',
					render: (setting) =>
						setting.addText((text) =>
							text
								.setPlaceholder('usuario@exemplo.com')
								.setValue(this.email)
								.onChange((value) => (this.email = value)),
						),
				},
				{
					name: 'Senha inicial',
					desc: 'A senha não pode ser recuperada. Guarde-a em um local seguro.',
					render: (setting) => {
						setting.addText((text) => {
							text.inputEl.type = 'password';
							text.setPlaceholder('Mínimo de 6 caracteres')
								.setValue(this.password)
								.onChange((value) => (this.password = value));
						});
					},
				},
				{
					name: 'Papel inicial',
					desc: 'Papel inicial do usuário.',
					render: (setting) =>
						setting.addDropdown((dropdown) =>
							dropdown
								.addOption('user', 'Usuário comum')
								.addOption('admin', 'Administrador')
								.setValue(this.role)
								.onChange(
									(value) => (this.role = value as UserRole),
								),
						),
				},
				{
					name: 'Criar usuário',
					desc: 'Cria a conta com os dados informados acima.',
					searchable: false,
					render: (setting) => {
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
										new Notice(
											'Já existe um usuário com esse e-mail.',
										);
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
									new Notice(
										`Usuário ${result.value.email} criado.`,
									);
									this.refresh();
								}),
						);
					},
				},
			],
		};
	}

	private reset(): void {
		this.name = '';
		this.email = '';
		this.password = '';
		this.role = 'user';
	}
}
