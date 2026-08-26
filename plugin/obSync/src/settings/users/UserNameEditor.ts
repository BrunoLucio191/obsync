import { Notice, type Setting } from 'obsidian';
import type { AuthenticatedUser } from '../../auth/auth.types.ts';
import { t } from '../../i18n/i18n.ts';
import type { SettingsController } from '../SettingsController.ts';
import type { UserDirectory } from './UserDirectory.ts';

export class UserNameEditor {
	private readonly saveTimers = new Map<number, number>();
	private readonly saveGenerations = new Map<number, number>();

	public constructor(
		private readonly controller: SettingsController,
		private readonly directory: UserDirectory,
	) {}

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

	public destroy(): void {
		for (const timer of this.saveTimers.values()) {
			window.clearTimeout(timer);
		}
		this.saveTimers.clear();
	}

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
