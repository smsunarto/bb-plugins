// Ranking adapted from T3 Code's modelPickerSearch.ts: every query token must
// match a field; earlier fields and tighter matches rank first, favorites get a boost.

export interface SearchableModel {
  name: string;
  model: string;
  providerName: string;
  isFavorite: boolean;
}

const FAVORITE_BOOST = 24;
const EXACT_NAME_SCORE = -1000;

function normalize(value: string) {
  return value
    .toLowerCase()
    .replace(/[\s_-]+/gu, " ")
    .trim();
}

function isSubsequence(value: string, token: string) {
  let index = 0;
  for (const character of value) {
    if (character === token[index]) index += 1;
    if (index === token.length) return true;
  }
  return false;
}

function scoreField(field: string, token: string, base: number, fuzzy: boolean): number | null {
  if (field === token) return base;
  if (field.startsWith(token)) return base + 2;
  if (field.includes(` ${token}`) || field.includes(`.${token}`)) return base + 4;
  if (field.includes(token)) return base + 6;
  if (fuzzy && token.length >= 3 && isSubsequence(field, token)) return base + 100;
  return null;
}

export function scoreModelSearch(model: SearchableModel, query: string): number | null {
  const tokens = normalize(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;
  if (tokens.join(" ") === normalize(model.name)) return EXACT_NAME_SCORE;
  const fields = [model.name, model.model, model.providerName].map(normalize);
  const combined = fields.length;
  // The joined text helps multi-word queries; fuzzy matching across it would match nearly anything.
  fields.push(fields.join(" "));
  let score = 0;
  for (const token of tokens) {
    const scores = fields.flatMap((field, index) => {
      const fieldScore = scoreField(field, token, index * 10, index < combined);
      return fieldScore === null ? [] : [fieldScore];
    });
    if (scores.length === 0) return null;
    score += Math.min(...scores);
  }
  return model.isFavorite ? score - FAVORITE_BOOST : score;
}

export function rankModelSearch<T>(
  items: readonly T[],
  query: string,
  toSearchable: (item: T) => SearchableModel,
): T[] {
  return items
    .flatMap((item, order) => {
      const score = scoreModelSearch(toSearchable(item), query);
      return score === null ? [] : [{ item, score, order }];
    })
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.item);
}
