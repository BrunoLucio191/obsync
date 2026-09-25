import { randomInt } from "node:crypto";

/** Cursor colors a new user can start with; each user can pick any other color later. */
const DEFAULT_USER_COLORS = ["#e74c3c", "#2ecc71", "#3498db", "#9b59b6", "#f39c12"];

/** Picks one of the default cursor colors for a newly created user. */
export const randomUserColor = (): string => {
  return DEFAULT_USER_COLORS[randomInt(DEFAULT_USER_COLORS.length)]!;
};

/**
 * Normalizes a cursor color into the stored form, a lowercase `#rrggbb` hex string.
 *
 * @param value - The raw color as provided by the caller.
 * @returns The normalized color, or `null` if `value` is not a 6-digit hex color.
 */
export const normalizeUserColor = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(color) ? color : null;
};
