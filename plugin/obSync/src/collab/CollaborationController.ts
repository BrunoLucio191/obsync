import type { Extension } from '@codemirror/state';
import { App, MarkdownView, Notice } from 'obsidian';
import { t } from '../i18n/i18n.ts';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import { closeCollabRoom, setupCollabRoom } from './collab.ts';

/** Minimal auth surface the controller needs to open collaboration rooms. */
export interface CollaborationAuth {
	readonly user: AuthenticatedUser | null;
	isReadOnlyUser(): boolean;
	createWebSocketTicket(channel: 'yjs'): Promise<string | null>;
}

/**
 * Orchestrates live collaboration for the currently active Markdown file: joins
 * a Yjs room when the active editor changes, tears it down when the file
 * changes or the plugin unloads, and keeps the editor's CodeMirror extensions
 * in sync with whichever room is open. Only one room is ever open at a time.
 */
export class CollaborationController {
	/** CodeMirror extensions currently registered for the active room's editor (empty when no room is open). */
	public readonly editorExtensions: Extension[] = [];
	private activePath: string | null = null;
	/** Monotonically incremented on every disconnect/join to invalidate in-flight async work from a stale attempt. */
	private roomGeneration = 0;
	private roomSyncTimer: number | null = null;
	private readonly privateModeNotices = new Set<string>();

	public constructor(
		private readonly app: App,
		private readonly auth: CollaborationAuth,
	) {}

	/** Vault path of the file whose collaboration room is currently open, or `null` if none. */
	public get currentPath(): string | null {
		return this.activePath;
	}

	/**
	 * Defers a sync of the active room to match the workspace's active file,
	 * debounced to the next tick since workspace events can fire before
	 * `getActiveFile()` reflects the change.
	 */
	public scheduleActiveRoomSync(): void {
		if (this.roomSyncTimer !== null) {
			window.clearTimeout(this.roomSyncTimer);
		}

		// Workspace events may fire before getActiveFile() is updated.
		this.roomSyncTimer = window.setTimeout(() => {
			this.roomSyncTimer = null;
			this.syncWithActiveFile();
		}, 0);
	}

	/**
	 * Reconnects the active file's collaboration room, used after the user's
	 * profile (e.g. role/permissions) changes so the room is rebuilt under the
	 * new identity.
	 */
	public refreshAfterProfileChange(): void {
		const activeFile = this.app.workspace.getActiveFile();
		this.disconnect();
		if (activeFile?.extension === 'md') void this.join(activeFile.path);
	}

	/** Closes the currently active collaboration room, if any, and clears its editor extensions. */
	public disconnect(): void {
		this.roomGeneration += 1;

		if (!this.activePath && this.editorExtensions.length === 0) {
			closeCollabRoom();
			return;
		}

		this.editorExtensions.length = 0;
		this.app.workspace.updateOptions();
		closeCollabRoom();
		this.activePath = null;
	}

	/**
	 * Disconnects the active room if the given vault path is the active room's
	 * file, or an ancestor folder of it (e.g. the folder was deleted/moved).
	 * @param path - The vault path that changed.
	 */
	public disconnectIfAffected(path: string): void {
		if (
			this.activePath &&
			PathMuteRegistry.contains(path, this.activePath)
		) {
			this.disconnect();
		}
	}

	/**
	 * Joins the collaboration room for a file: disconnects any current room,
	 * sets up the new one, and swaps the editor's content/extensions once ready.
	 * Aborts safely if the active editor view changes to a different file, or
	 * a newer `join`/`disconnect` call supersedes this one, while it was in flight.
	 * @param filePath - Vault-relative path of the file to join.
	 */
	public async join(filePath: string): Promise<void> {
		const user = this.auth.user;
		if (!user || this.activePath === filePath) return;

		this.disconnect();
		const generation = ++this.roomGeneration;
		this.activePath = filePath;

		try {
			this.showPrivateModeNotice(filePath);

			const initialView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!initialView || initialView.file?.path !== filePath) {
				this.disconnect();
				return;
			}

			const preparedRoom = await setupCollabRoom(
				filePath,
				user,
				this.requestYjsWebSocketTicket,
				(name) => {
					if (this.activePath === filePath) {
						new Notice(t('collab.userJoinedNote', { name }));
					}
				},
				(name) => {
					if (this.activePath === filePath) {
						new Notice(t('collab.userLeftNote', { name }));
					}
				},
			);

			if (
				!preparedRoom ||
				generation !== this.roomGeneration ||
				this.activePath !== filePath
			) {
				return;
			}

			const activeView =
				this.app.workspace.getActiveViewOfType(MarkdownView);
			if (!activeView || activeView.file?.path !== filePath) {
				this.disconnect();
				return;
			}

			this.restoreEditorText(activeView, preparedRoom.initialText);
			this.editorExtensions.push(preparedRoom.extension);
			this.app.workspace.updateOptions();
			preparedRoom.connect();
		} catch (error) {
			if (generation !== this.roomGeneration) return;

			console.error(
				t('collab.couldNotInitializeCollaboration', { filePath }),
				error,
			);
			this.disconnect();
			new Notice(t('collab.couldNotRestoreOfflineHistory'));
		}
	}

	/** Cancels any pending sync timer and disconnects the active room; call when the plugin unloads. */
	public destroy(): void {
		if (this.roomSyncTimer !== null) {
			window.clearTimeout(this.roomSyncTimer);
			this.roomSyncTimer = null;
		}
		this.disconnect();
	}

	/** Requests a fresh websocket auth ticket for the `yjs` channel, bound to the current auth service. */
	private readonly requestYjsWebSocketTicket = (): Promise<string | null> =>
		this.auth.createWebSocketTicket('yjs');

	/**
	 * Joins or disconnects the collaboration room to match the workspace's
	 * currently active file (only Markdown files get a room).
	 */
	private syncWithActiveFile(): void {
		const activeFile = this.app.workspace.getActiveFile();

		if (!activeFile || activeFile.extension !== 'md') {
			this.disconnect();
			return;
		}

		if (this.activePath !== activeFile.path) {
			void this.join(activeFile.path);
		}
	}

	/**
	 * Shows a one-time notice informing a read-only user that they are viewing
	 * a file in private/read-only collaboration mode.
	 * @param filePath - The file being opened, used to dedupe repeat notices.
	 */
	private showPrivateModeNotice(filePath: string): void {
		if (
			!this.auth.isReadOnlyUser() ||
			this.privateModeNotices.has(filePath)
		) {
			return;
		}

		this.privateModeNotices.add(filePath);
		new Notice(t('collab.privateModeNotice'));
	}

	/**
	 * Replaces the editor's content with the room's initial (offline-restored)
	 * text if it differs, preserving the cursor position as closely as possible.
	 * @param view - The Markdown view whose editor content is being restored.
	 * @param initialText - Text to restore into the editor.
	 */
	private restoreEditorText(
		view: MarkdownView,
		initialText: string,
	): void {
		if (view.editor.getValue() === initialText) return;

		const cursorOffset = view.editor.posToOffset(view.editor.getCursor());
		view.editor.setValue(initialText);
		view.editor.setCursor(
			view.editor.offsetToPos(Math.min(cursorOffset, initialText.length)),
		);
	}
}
