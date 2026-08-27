/**
 * A successful authentication result returned by the backend on login or
 * token refresh: the short-lived access token, the long-lived refresh
 * token, the access token's lifetime in seconds, and the authenticated
 * user's profile.
 */
export type AuthSession = {
	token: string;
	refreshToken: string;
	expiresIn: number;
	user: AuthenticatedUser;
};

export type WebSocketChannel = 'system' | 'yjs';

/**
 * A short-lived, single-use ticket used to authenticate a WebSocket
 * upgrade request (WebSocket requests can't carry an `Authorization`
 * header, so a ticket is exchanged for one beforehand over HTTP).
 */
export type WebSocketTicket = {
	ticket: string;
	expiresIn: number;
};

export type UserRole = 'admin' | 'user';

export type AuthenticatedUser = {
	id: number;
	email: string;
	name: string;
	role: UserRole;
	active: boolean;
};

/**
 * Discriminated-union result for user-management operations, avoiding
 * thrown exceptions for expected/recoverable failures (validation errors,
 * permission denials, etc.) so callers can branch on `ok` and show
 * `error` to the user.
 */
export type UserActionResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };
