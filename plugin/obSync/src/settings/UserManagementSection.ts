import type { Setting, SettingDefinitionItem } from 'obsidian';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import { t } from '../i18n/i18n.ts';
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
		return [...this.list.definitions(), this.createForm.definition()];
	}

	public renderEditableName(
		setting: Setting,
		user: AuthenticatedUser,
	): void {
		this.nameEditor.render(
			setting,
			user,
			t('settings.account.yourDisplayName'),
			t('settings.account.yourDisplayNameDesc'),
		);
	}

	public destroy(): void {
		this.list.destroy();
		this.nameEditor.destroy();
	}
}
