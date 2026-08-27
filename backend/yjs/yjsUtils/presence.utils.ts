/**
 * Normalizes a raw identity value (typically an email) into a canonical presence id
 * so identities can be compared regardless of casing/whitespace.
 * @param value - Candidate identity value; anything that isn't a non-empty string is rejected.
 * @returns The trimmed, lowercased identity, or `null` if `value` is not a usable string.
 */
export function normalizePresenceIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Extracts and normalizes the presence identity embedded in a decoded awareness state object.
 * @param state - Decoded awareness state (expected shape `{ user: { id } }`); may be anything.
 * @returns The normalized identity found at `state.user.id`, or `null` if absent/invalid.
 */
export function getAwarenessPresenceIdentity(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;

  const user = (state as { user?: { id?: unknown } }).user;
  return normalizePresenceIdentity(user?.id);
}
