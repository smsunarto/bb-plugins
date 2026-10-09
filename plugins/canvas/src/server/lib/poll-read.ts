import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { canvasHostContract } from "../../shared/host-contract.ts";
import type { FileLocation } from "../locate.ts";

type FileRead = Awaited<ReturnType<BbPluginApi["sdk"]["files"]["read"]>>;

// The host stamp each location had just before its last read, with the hash
// that read returned. A stamp taken after a read could already describe a
// newer write, so only the earlier one is ever trusted.
const lastReads = new Map<string, { readonly stamp: string; readonly sha256: string }>();
const remembered = 512;
const stampTimeoutMs = 5000;

async function stampOf(bb: BbPluginApi, location: FileLocation): Promise<string | null> {
  try {
    const client = bb.hosts.experimental_client({ contract: canvasHostContract });
    const { stamp } = await client.call(
      "stamp",
      { path: location.path },
      { hostId: location.hostId, timeoutMs: stampTimeoutMs },
    );
    return stamp;
  } catch {
    // A daemon without this host entry yet, or a host link hiccup: read as before.
    return null;
  }
}

/**
 * `bb.sdk.files.read` for a poll that already holds `knownSha256`. Open
 * canvases poll every 1.5 s, and the file usually lives on another machine,
 * so the host stats it first: an unchanged file costs a stamp instead of its
 * whole content. A deleted file reads as missing without a second call.
 */
export async function pollRead(
  bb: BbPluginApi,
  location: FileLocation,
  knownSha256: string | null,
): Promise<FileRead | { readonly unchanged: string }> {
  if (knownSha256 === null) return bb.sdk.files.read(location);
  const key = `${location.hostId}\0${location.path}`;
  const stamp = await stampOf(bb, location);
  if (stamp === "absent") {
    lastReads.delete(key);
    throw new Error(`ENOENT: no such file or directory, stat '${location.path}'`);
  }
  const last = lastReads.get(key);
  if (stamp !== null && last?.stamp === stamp && last.sha256 === knownSha256) {
    return { unchanged: knownSha256 };
  }
  lastReads.delete(key);
  const file = await bb.sdk.files.read(location);
  if (stamp !== null) {
    lastReads.set(key, { stamp, sha256: file.sha256 });
    const oldest = lastReads.keys().next();
    if (lastReads.size > remembered && !oldest.done) lastReads.delete(oldest.value);
  }
  return file;
}
