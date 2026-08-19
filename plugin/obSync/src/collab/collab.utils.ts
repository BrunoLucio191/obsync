import { Colors } from './collab.cons.ts';
import { CollaborationUser } from './collab.types.ts';
import { PresenceUser } from './collab.types.ts';

export function normalizePresenceId(value: string): string {
	return value.trim().toLowerCase();
}

export function getPresenceUser(user: CollaborationUser): PresenceUser {
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
