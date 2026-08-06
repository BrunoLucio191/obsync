export const normalizeEmailKey = (value: string): string => {
  return value.normalize("NFKC").trim().toLowerCase();
};
export const normalizeName = (value: string): string => {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
};
export const normalizeNameKey = (value: string): string => {
  return normalizeName(value).toLocaleLowerCase("pt-BR");
};
