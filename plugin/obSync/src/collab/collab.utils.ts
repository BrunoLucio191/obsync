import { CollaborationUser } from './collab.types.ts';
import { PresenceUser } from './collab.types.ts';

export function normalizePresenceId(value: string): string {
	return value.trim().toLowerCase();
}

export function getPresenceUser(user: CollaborationUser): PresenceUser {
	return {
		id: normalizePresenceId(user.email),
		name: user.name,
		color: user.color,
		colorLight: `${user.color}33`,
	};
}
