import { CollaborationUser } from './collab.types.ts';
import { PresenceUser } from './collab.types.ts';

/**
 * Normalizes a presence identifier (typically an email) so the same person is
 * recognized consistently regardless of casing or surrounding whitespace.
 * @param value - Raw identifier to normalize.
 * @returns The trimmed, lower-cased identifier.
 */
export function normalizePresenceId(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Builds the awareness presence payload broadcast for a collaborating user,
 * using the cursor color the user picked, which is stored on the backend.
 * @param user - The collaboration user to build a presence payload for.
 * @returns The presence data to publish via Yjs awareness.
 */
export function getPresenceUser(user: CollaborationUser): PresenceUser {
	return {
		id: normalizePresenceId(user.email),
		name: user.name,
		color: user.color,
		colorLight: `${user.color}33`,
	};
}
