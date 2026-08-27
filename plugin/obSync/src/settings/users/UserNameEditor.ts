import { Notice, type Setting } from 'obsidian';
import type { AuthenticatedUser } from '../../auth/auth.types.ts';
import { t } from '../../i18n/i18n.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';

/**
 * Renders and debounce-saves a user's editable display-name field, shared
 * between the "Account" section (editing your own name) and the user-list
 * rows (editing another user's name). Validates length, checks for
 * duplicates against the cached directory, and shows inline save-status
 * text instead of requiring an explicit save button.
 */
export class UserNameEditor {
	private readonly saveTimers = new Map<number, number>();
	private readonly saveGenerations = new Map<number, number>();

	public constructor(
		private readonly controller: SettingsController,
		private readonly directory: UserDirectory,
	) {}

	/** Renders a labeled name field with an inline save-status indicator, and wires its `onChange` to `scheduleSave`. */
	public render(
		setting: Setting,
		user: AuthenticatedUser,
		label: string,
		description: string,
	): void {
		setting.setName(label).setDesc(description);
		const statusEl = setting.descEl.createDiv({
			cls: 'obsync-setting-save-status',
			text: t('settings.users.nameSaved'),
		});
		setting.addText((text) => {
			text.setValue(user.name)
				.setPlaceholder(t('settings.users.displayName'))
				.onChange((value) => {
					this.scheduleSave(
						user,
						value,
						statusEl,
						text.inputEl,
					);
				});
		});
	}

	/**
	 * Debounces (500ms) a name change and persists it once the input settles,
	 * after validating length and checking for a duplicate name. Uses a
	 * per-user generation counter so an in-flight save can't overwrite a
	 * newer edit or write into a stale/detached input.
	 */
	public scheduleSave(
		user: AuthenticatedUser,
		value: string,
		statusEl: HTMLElement,
		inputEl: HTMLInputElement,
		onSaved?: () => void,
	): void {
		const normalizedName = value.trim();
		const generation = (this.saveGenerations.get(user.id) ?? 0) + 1;
		this.saveGenerations.set(user.id, generation);

		const currentTimer = this.saveTimers.get(user.id);
		if (currentTimer !== undefined) {
			window.clearTimeout(currentTimer);
			this.saveTimers.delete(user.id);
		}

		if (normalizedName.length < 2 || normalizedName.length > 64) {
			statusEl.setText(t('settings.users.nameUseLength'));
			return;
		}
		if (normalizedName === user.name) {
			statusEl.setText(t('settings.users.nameSaved'));
			return;
		}

		const duplicateUser = this.directory.findByName(
			normalizedName,
			user.id,
		);
		if (duplicateUser) {
			statusEl.setText(
				t('settings.users.nameAlreadyUsedBy', {
					email: duplicateUser.email,
				}),
			);
			return;
		}

		statusEl.setText(t('settings.users.saving'));
		const timer = window.setTimeout(() => {
			this.saveTimers.delete(user.id);
			void this.persist(
				user,
				normalizedName,
				generation,
				statusEl,
				inputEl,
				onSaved,
			);
		}, 500);
		this.saveTimers.set(user.id, timer);
	}

	/** Cancels every pending debounced save timer, e.g. when the settings tab closes. */
	public destroy(): void {
		for (const timer of this.saveTimers.values()) {
			window.clearTimeout(timer);
		}
		this.saveTimers.clear();
	}

	/**
	 * Sends the name update to the backend and reconciles UI/cache state,
	 * bailing out silently if a newer edit superseded this one or the input
	 * has since been removed from the DOM.
	 */
	private async persist(
		user: AuthenticatedUser,
		name: string,
		generation: number,
		statusEl: HTMLElement,
		inputEl: HTMLInputElement,
		onSaved?: () => void,
	): Promise<void> {
		const previousName = user.name;
		const result = await this.controller.updateUserName(user.id, name);
		if (
			generation !== this.saveGenerations.get(user.id) ||
			!statusEl.isConnected
		) {
			return;
		}

		if (!result.ok) {
			inputEl.value = previousName;
			statusEl.setText(t('settings.users.saveError'));
			new Notice(result.error);
			return;
		}

		user.name = result.value.name;
		this.directory.replace(result.value);
		inputEl.value = result.value.name;
		statusEl.setText(t('settings.users.nameSaved'));
		onSaved?.();
	}
}
