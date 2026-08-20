import { SettingGroup } from 'obsidian';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import type { SettingsController } from './SettingsController.ts';
import type { UserManagementSection } from './UserManagementSection.ts';

export class AccountSettingsSection {
	public constructor(
		private readonly controller: SettingsController,
		private readonly users: UserManagementSection,
		private readonly refresh: () => void,
	) {}

	public render(container: HTMLElement, currentUser: AuthenticatedUser): void {
		const group = new SettingGroup(container).setHeading('Conta');

		group.addSetting((setting) => {
			setting
				.setName('Usuário conectado')
				.setDesc(
					`${currentUser.email} • ${currentUser.role === 'admin' ? 'Administrador' : 'Usuário comum'}`,
				);
		});

		if (currentUser.role === 'admin') {
			this.users.renderEditableName(
				group,
				currentUser,
				'Seu nome de exibição',
				'Como administrador, você pode alterar seu próprio nome. A mudança é enviada automaticamente.',
			);
		} else {
			group.addSetting((setting) => {
				setting
					.setName('Nome de exibição')
					.setDesc(
						`${currentUser.name}. Somente administradores podem alterar nomes de usuários.`,
					);
			});
		}

		if (currentUser.role === 'user') {
			group.addSetting((setting) => {
				setting
					.setName('Modo privado')
					.setDesc(
						'Suas edições de texto ficam somente neste dispositivo. Você recebe mudanças globais, mas não pode publicá-las no vault compartilhado.',
					);
			});
		}

		group.addSetting((setting) => {
			setting
				.setName('Sessão')
				.setDesc(
					'Encerra a sessão atual e permite entrar com outra conta.',
				)
				.addButton((button) =>
					button.setButtonText('Sair').onClick(async () => {
						await this.controller.logout();
						this.refresh();
					}),
				);
		});
	}
}
