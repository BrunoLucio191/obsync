import type { ObSyncConfig } from '../config/ObSyncConfig.ts';
import type {
	AuthenticatedUser,
	UserActionResult,
	UserRole,
} from '../auth/auth.types.ts';

/**
 * Backend contract the settings-tab UI sections depend on for reading
 * config and performing auth/account/user-management mutations. Implemented
 * elsewhere (outside this directory) and injected into each section so the
 * UI code stays decoupled from how requests are actually made.
 */
export interface SettingsController {
	/** The plugin's current persisted configuration (backend URL, session, signed-in user). */
	readonly config: ObSyncConfig;
	setBackendUrl(url: string): Promise<UserActionResult<null>>;
	isAuthenticated(): boolean;
	openLogin(): Promise<boolean>;
	logout(): Promise<void>;
	listUsers(): Promise<UserActionResult<AuthenticatedUser[]>>;
	/** Creates a new user account (admin-only operation). */
	createUser(input: {
		name: string;
		email: string;
		password: string;
		role: UserRole;
	}): Promise<UserActionResult<AuthenticatedUser>>;
	updateUserName(
		userId: number,
		name: string,
	): Promise<UserActionResult<AuthenticatedUser>>;
	/** Changes a user's role (admin-only operation). */
	updateUserRole(
		userId: number,
		role: UserRole,
	): Promise<UserActionResult<AuthenticatedUser>>;
	/** Activates or deactivates a user account (admin-only operation). */
	updateUserStatus(
		userId: number,
		active: boolean,
	): Promise<UserActionResult<AuthenticatedUser>>;
	/** Permanently deletes a user account (admin-only operation). */
	deleteUser(userId: number): Promise<UserActionResult<AuthenticatedUser>>;
	/** Resets another user's password (admin-only operation). */
	resetUserPassword(
		userId: number,
		newPassword: string,
	): Promise<UserActionResult<AuthenticatedUser>>;
	changePassword(
		currentPassword: string,
		newPassword: string,
	): Promise<UserActionResult<null>>;
}
