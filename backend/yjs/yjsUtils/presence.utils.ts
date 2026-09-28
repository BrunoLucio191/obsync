export function normalizePresenceIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function getAwarenessPresenceIdentity(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;

  const user = (state as { user?: { id?: unknown } }).user;
  return normalizePresenceIdentity(user?.id);
}
