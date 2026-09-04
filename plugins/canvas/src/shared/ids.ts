// Callers mint ids so "open" and "reply" stay idempotent across retries.

const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

export function newId(prefix: "cmt" | "msg"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return `${prefix}_${out}`;
}
