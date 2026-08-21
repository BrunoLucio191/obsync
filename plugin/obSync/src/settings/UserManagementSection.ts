import type { Setting, SettingDefinitionItem } from 'obsidian';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import type { SettingsController } from './SettingsController.ts';
import { CreateUserSection } from './users/CreateUserSection.ts';
import { UserDirectory } from './users/UserDirectory.ts';
import { UserListSection } from './users/UserListSection.ts';
import { UserNameEditor } from './users/UserNameEditor.ts';

export class UserManagementSection {
	private readonly directory: UserDirectory;
	private readonly nameEditor: UserNameEditor;
	private readonly list: UserListSection;
	private readonly createForm: CreateUserSection;

	public constructor(
		controller: SettingsController,
		refresh: () => void,
	) {
		this.directory = new UserDirectory();
		this.nameEditor = new UserNameEditor(controller, this.directory);
		this.list = new UserListSection(
			controller,
			this.directory,
			this.nameEditor,
			refresh,
		);
		this.createForm = new CreateUserSection(
			controller,
			this.directory,
			refresh,
		);
	}

	public definitions(): SettingDefinitionItem[] {
		return [this.list.definition(), this.createForm.definition()];
	}

	public renderEditableName(
		setting: Setting,
		user: AuthenticatedUser,
	): void {
		this.nameEditor.render(
			setting,
			user,
			'Seu nome de exibição',
			'Como administrador, você pode alterar seu próprio nome. A mudança é enviada automaticamente.',
		);
	}

	public destroy(): void {
		this.list.destroy();
		this.nameEditor.destroy();
	}
}
