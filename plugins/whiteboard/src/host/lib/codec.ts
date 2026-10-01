import { HOST_PAYLOAD_LIMIT_BYTES } from "../../shared/contracts/host-contract.ts";
import {
  decodeWire,
  encodeWire,
  toWireError,
  type VcsHandle,
  type WireError,
  type WireResult,
  type WireValue,
} from "../../shared/contracts/wire.ts";
import type { LocalVcs } from "../../shared/node/vendor/local-vcs/src/index.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";
import { rehydrateVcs } from "./vcs-handles.ts";

/**
 * Host side of the wire codec (design §3.1): arguments in, results and
 * failures out. `ReviewInputError` keeps its name and status so the server
 * rehydrates the same class; a result above the hop limit becomes
 * `PayloadTooLarge`, which the diff facades answer by splitting.
 */

export const PAYLOAD_TOO_LARGE = "PayloadTooLarge";

export function hostError(error: unknown): WireError {
  const wire = toWireError(error);
  return error instanceof ReviewInputError ? { ...wire, name: "ReviewInputError" } : wire;
}

export function failure(error: unknown): WireResult {
  return { ok: false, error: hostError(error) };
}

/** Bytes of a JSON value as the worker serializes it. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null");
}

export function hostResult(value: unknown): WireResult {
  if (value === undefined) return { ok: true };
  const encoded = encodeWire(value);
  const size = jsonBytes(encoded);
  if (size > HOST_PAYLOAD_LIMIT_BYTES) {
    return {
      ok: false,
      error: {
        name: PAYLOAD_TOO_LARGE,
        message: `whiteboard: the host result is ${size} bytes, above the ${HOST_PAYLOAD_LIMIT_BYTES}-byte host transfer limit.`,
      },
    };
  }
  return { ok: true, value: encoded };
}

function collectHandles(value: WireValue, out: Map<string, VcsHandle>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectHandles(item, out);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "$vcs") {
    const handle = value.$vcs as VcsHandle;
    out.set(handleKey(handle), handle);
    return;
  }
  for (const item of Object.values(value)) collectHandles(item as WireValue, out);
}

function handleKey(handle: VcsHandle): string {
  return `${handle.kind}\0${handle.rootPath}`;
}

/** Decode hop arguments; `$vcs` handles become live `LocalVcs` objects on this host. */
export async function decodeArgs(args: readonly WireValue[]): Promise<unknown[]> {
  const handles = new Map<string, VcsHandle>();
  for (const arg of args) collectHandles(arg, handles);
  const live = new Map<string, LocalVcs>();
  await Promise.all(
    [...handles].map(async ([key, handle]) => live.set(key, await rehydrateVcs(handle))),
  );
  return args.map((arg) => decodeWire(arg, (handle) => live.get(handleKey(handle))));
}
