import type { Extension } from '@codemirror/state';
import { App, MarkdownView, Notice } from 'obsidian';
import type { AuthenticatedUser } from '../auth/auth.types.ts';
import { PathMuteRegistry } from '../vault/PathMuteRegistry.ts';
import { closeCollabRoom, setupCollabRoom } from './collab.ts';

export interface CollaborationAuth {
	readonly user: AuthenticatedUser | null;
	isReadOnlyUser(): boolean;
	createWebSocketTicket(channel: 'yjs'): Promise<string | null>;
}

export class CollaborationController {
	public readonly editorExtensions: Extension[] = [];
	private activePath: string | null = null;
	private roomGeneration = 0;
	private roomSyncTimer: number | null = null;
	private readonly privateModeNotices = new Set<string>();

	public constructor(
		private readonly app: App,
		private readonly auth: CollaborationAuth,
	) {}

	public get currentPath(): string | null {
		return this.activePath;
	}

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

	public refreshAfterProfileChange(): void {
		const activeFile = this.app.workspace.getActiveFile();
		this.disconnect();
		if (activeFile?.extension === 'md') void this.join(activeFile.path);
	}

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

	public disconnectIfAffected(path: string): void {
		if (
			this.activePath &&
			PathMuteRegistry.contains(path, this.activePath)
		) {
			this.disconnect();
		}
	}

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
						new Notice(`${name} entrou nesta nota.`);
					}
				},
				(name) => {
					if (this.activePath === filePath) {
						new Notice(`${name} saiu desta nota.`);
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
				`Não foi possível inicializar a colaboração em ${filePath}:`,
				error,
			);
			this.disconnect();
			new Notice(
				'Não foi possível restaurar o histórico offline desta nota.',
			);
		}
	}

	public destroy(): void {
		if (this.roomSyncTimer !== null) {
			window.clearTimeout(this.roomSyncTimer);
			this.roomSyncTimer = null;
		}
		this.disconnect();
	}

	private readonly requestYjsWebSocketTicket = (): Promise<string | null> =>
		this.auth.createWebSocketTicket('yjs');

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

	private showPrivateModeNotice(filePath: string): void {
		if (
			!this.auth.isReadOnlyUser() ||
			this.privateModeNotices.has(filePath)
		) {
			return;
		}

		this.privateModeNotices.add(filePath);
		new Notice(
			'Você está em modo privado: suas edições ficam apenas neste dispositivo.',
		);
	}

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
