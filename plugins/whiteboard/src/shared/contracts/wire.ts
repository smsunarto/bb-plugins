import { z } from "zod";

/**
 * The host-hop value codec (design §3.1). Every host RPC argument and result is
 * plain JSON. Three values JSON cannot carry travel as tagged objects:
 *
 * - bytes (`Uint8Array`, `Buffer`) as `{ $bytes: "<base64>" }`
 * - `bigint` as `{ $bigint: "<decimal>" }`
 * - a `LocalVcs` object as `{ $vcs: { kind, rootPath } }`. The host rehydrates it
 *   with `detectLocalVcs(rootPath)`; the server rehydrates it as a proxy.
 *
 * `undefined` object members are dropped and `undefined` array items become
 * `null`, as `JSON.stringify` does.
 */
export const vcsHandle = z.strictObject({
  kind: z.enum(["git", "jj"]),
  rootPath: z.string().min(1).max(4096),
});
export type VcsHandle = z.infer<typeof vcsHandle>;

export const wireValue = z.json();
export type WireValue = z.infer<typeof wireValue>;

/** A failure crossing a hop. `status` carries `ReviewInputError.status`, `code` an errno code. */
export const wireError = z.strictObject({
  name: z.string(),
  message: z.string(),
  status: z.number().int().optional(),
  code: z.string().optional(),
});
export type WireError = z.infer<typeof wireError>;

/** The envelope `invoke` and `vcsCall` return. */
export const wireResult = z.strictObject({
  ok: z.boolean(),
  value: wireValue.optional(),
  error: wireError.optional(),
});
export type WireResult = z.infer<typeof wireResult>;

type VcsLike = { kind: "git" | "jj"; rootPath: string };

function isVcsLike(value: object): value is VcsLike {
  const candidate = value as Partial<VcsLike> & { readFileAtRef?: unknown };
  return (
    (candidate.kind === "git" || candidate.kind === "jj") &&
    typeof candidate.rootPath === "string" &&
    typeof candidate.readFileAtRef === "function"
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Encode a value for a host hop. Throws on functions, symbols and cycles. */
export function encodeWire(value: unknown, seen = new Set<object>()): WireValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value === undefined) return null;
  if (typeof value !== "object") throw new TypeError(`cannot encode a ${typeof value}`);
  if (value instanceof Uint8Array) return { $bytes: bytesToBase64(value) };
  if (seen.has(value)) throw new TypeError("cannot encode a cyclic value");
  if (isVcsLike(value)) return { $vcs: { kind: value.kind, rootPath: value.rootPath } };
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => encodeWire(item, seen));
    const out: Record<string, WireValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) out[key] = encodeWire(item, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** Decode a hop value. `vcs` turns a `$vcs` handle back into a live object. */
export function decodeWire(value: WireValue, vcs: (handle: VcsHandle) => unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => decodeWire(item, vcs));
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [key] = keys;
    const inner = value[key!];
    if (key === "$bytes" && typeof inner === "string") return base64ToBytes(inner);
    if (key === "$bigint" && typeof inner === "string") return BigInt(inner);
    if (key === "$vcs") return vcs(vcsHandle.parse(inner));
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = decodeWire(item as WireValue, vcs);
  return out;
}

/** The wire shape of any thrown value. */
export function toWireError(error: unknown): WireError {
  if (!(error instanceof Error)) return { name: "Error", message: String(error) };
  const extra = error as Error & { status?: unknown; code?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof extra.status === "number" ? { status: extra.status } : {}),
    ...(typeof extra.code === "string" ? { code: extra.code } : {}),
  };
}
