import { Colors } from './collab.cons.ts';
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
 * including a color deterministically derived from their email so the same
 * user always gets the same cursor color across sessions.
 * @param user - The collaboration user to build a presence payload for.
 * @returns The presence data to publish via Yjs awareness.
 */
export function getPresenceUser(user: CollaborationUser): PresenceUser {
	/**
	 * Derives a deterministic color for an email by summing character codes
	 * and indexing into the shared {@link Colors} palette.
	 * @param email - Email address to derive a color from.
	 * @returns A hex color string from the palette.
	 */
	function getUserColor(email: string): string {
		const index =
			[...email].reduce(
				(total, character) => total + character.charCodeAt(0),
				0,
			) % Colors.length;
		return Colors[index] ?? '#3498db';
	}

	const color = getUserColor(user.email);
	return {
		id: normalizePresenceId(user.email),
		name: user.name,
		color,
		colorLight: `${color}33`,
	};
}
