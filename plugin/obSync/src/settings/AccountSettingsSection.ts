import type { SettingDefinition, SettingDefinitionGroup } from 'obsidian';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import type { SettingsController } from './SettingsController.ts';
import type { UserManagementSection } from './UserManagementSection.ts';

export class AccountSettingsSection {
	public constructor(
		private readonly controller: SettingsController,
		private readonly users: UserManagementSection,
		private readonly refresh: () => void,
	) {}

	public definition(currentUser: AuthenticatedUser): SettingDefinitionGroup {
		const items: SettingDefinition[] = [
			{
				name: 'Usuário conectado',
				desc: `${currentUser.email} • ${currentUser.role === 'admin' ? 'Administrador' : 'Usuário comum'}`,
			},
		];

		if (currentUser.role === 'admin') {
			items.push({
				name: 'Seu nome de exibição',
				desc: 'Como administrador, você pode alterar seu próprio nome. A mudança é enviada automaticamente.',
				render: (setting) =>
					this.users.renderEditableName(setting, currentUser),
			});
		} else {
			items.push({
				name: 'Nome de exibição',
				desc: `${currentUser.name}. Somente administradores podem alterar nomes de usuários.`,
			});
		}

		if (currentUser.role === 'user') {
			items.push({
				name: 'Modo privado',
				desc: 'Suas edições de texto ficam somente neste dispositivo. Você recebe mudanças globais, mas não pode publicá-las no vault compartilhado.',
			});
		}

		items.push({
			name: 'Sessão',
			desc: 'Encerra a sessão atual e permite entrar com outra conta.',
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText('Sair').onClick(async () => {
						await this.controller.logout();
						this.refresh();
					}),
				);
			},
		});

		return {
			type: 'group',
			heading: 'Conta',
			items,
		};
	}
}
