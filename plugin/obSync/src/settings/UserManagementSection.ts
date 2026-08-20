import type { SettingGroup } from 'obsidian';
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
		);
		this.createForm = new CreateUserSection(
			controller,
			this.directory,
			refresh,
		);
	}

	public render(container: HTMLElement): void {
		this.list.render(container);
		this.createForm.render(container);
	}

	public renderEditableName(
		group: SettingGroup,
		user: AuthenticatedUser,
		label: string,
		description: string,
	): void {
		this.nameEditor.render(group, user, label, description);
	}

	public destroy(): void {
		this.list.destroy();
		this.nameEditor.destroy();
	}
}
