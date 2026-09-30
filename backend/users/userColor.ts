import { randomInt } from "node:crypto";

/** Cursor colors a new user can start with; each user can pick any other color later. */
const DEFAULT_USER_COLORS = [
  "#e74c3c",
  "#2ecc71",
  "#3498db",
  "#9b59b6",
  "#f39c12",
];

export const randomUserColor = (): string => {
  return DEFAULT_USER_COLORS[randomInt(DEFAULT_USER_COLORS.length)]!;
};

export const normalizeUserColor = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const color = value.trim().toLowerCase();

  //verify if you have an hex value
  return /^#[0-9a-f]{6}$/.test(color) ? color : null;
};
