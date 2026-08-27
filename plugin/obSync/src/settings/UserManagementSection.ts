import type { Setting, SettingDefinitionItem } from 'obsidian';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import { t } from '../i18n/i18n.ts';
import type { SettingsController } from './SettingsController.ts';
import { CreateUserSection } from './users/CreateUserSection.ts';
import { UserDirectory } from './users/UserDirectory.ts';
import { UserListSection } from './users/UserListSection.ts';
import { UserNameEditor } from './users/UserNameEditor.ts';

/**
 * Coordinates the admin-only user-management UI: owns the shared
 * `UserDirectory` cache and wires it into the user-list, name-editing, and
 * create-user sub-sections. Also exposes the name editor for reuse by the
 * "Account" section, so a user's own name is edited through the same
 * debounced-save logic.
 */
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

	/** Renders an editable display-name field, delegating to the shared `UserNameEditor` (debounced autosave, duplicate checks). */
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

	/** Tears down pending timers/state in the list and name-editor sub-sections. */
	public destroy(): void {
		this.list.destroy();
		this.nameEditor.destroy();
	}
}
