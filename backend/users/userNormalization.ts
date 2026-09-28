export const normalizeEmailKey = (value: string): string => {
  return value.normalize("NFC").trim().toLowerCase();
};

/** Case is kept so the name still displays as typed. */
export const normalizeName = (value: string): string => {
  return value.normalize("NFC").trim().replace(/\s+/g, " ");
};

/** pt-BR case folding, so names that look the same collide as duplicates. */
export const normalizeNameKey = (value: string): string => {
  return normalizeName(value).toLocaleLowerCase("pt-BR");
};
