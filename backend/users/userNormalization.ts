/**
 * Normalizes a raw email address into the canonical form used as a lookup
 * key (and storage value) for uniqueness checks in the users table.
 *
 * @param value - The raw email address as provided by the caller.
 * @returns The Unicode-normalized (NFC), trimmed, lower-cased email.
 */
export const normalizeEmailKey = (value: string): string => {
  return value.normalize("NFC").trim().toLowerCase();
};

/**
 * Normalizes a display name for storage: fixes Unicode composition, trims
 * surrounding whitespace, and collapses internal whitespace runs to a
 * single space. Case is preserved so the name still displays naturally.
 *
 * @param value - The raw display name as provided by the caller.
 * @returns The cleaned-up display name.
 */
export const normalizeName = (value: string): string => {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
};

/**
 * Derives the case-insensitive lookup key used to enforce unique names,
 * using pt-BR locale rules for case folding (relevant for accented
 * characters) so visually-identical names collide as duplicates.
 *
 * @param value - The raw display name as provided by the caller.
 * @returns The normalized, lower-cased name key.
 */
export const normalizeNameKey = (value: string): string => {
  return normalizeName(value).toLocaleLowerCase("pt-BR");
};
