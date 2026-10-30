import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { threadRoots } from "./data-source";
import { THREAD_STORAGE_PREFIX } from "./core/file-target";

type Lease = { baseUrl: string; expiresAtMs: number };
type VideoUrl =
  | { ok: true; url: string; expiresAtMs: number; owned: false }
  | { ok: false; error: string };
// Scoped to a plugin instance; reloads cannot reuse leases issued by an old server.
const caches = new WeakMap<BbPluginApi, Map<string, Promise<Lease>>>();
const RENEW_MARGIN_MS = 60_000;

/** Resolve only the thread's workspace/storage. A preview must never expose all of /tmp. */
export async function previewThreadVideo(
  bb: BbPluginApi,
  threadId: string,
  requested: string,
  renew = false,
): Promise<VideoUrl> {
  try {
    if (!/\.(mp4|webm|mov|ogv)$/i.test(requested))
      return {
        ok: false,
        error: "Video needs an mp4, webm, mov or ogv file; H.264 MP4 is recommended.",
      };
    if (
      /^[a-z][a-z\d+.-]*:/i.test(requested) ||
      requested.includes("\\") ||
      requested.includes("\0")
    ) {
      return {
        ok: false,
        error: "Download remote clips into $BB_THREAD_STORAGE and use that file path.",
      };
    }
    const roots = await threadRoots(bb, threadId);
    const isStorage = requested.startsWith(THREAD_STORAGE_PREFIX);
    const absolute = path.isAbsolute(requested);
    const candidates = isStorage
      ? [roots.storage]
      : absolute
        ? [roots.storage, roots.workspace]
        : [roots.workspace];
    const relative = isStorage ? requested.slice(THREAD_STORAGE_PREFIX.length) : requested;
    const found = candidates.flatMap((root) => {
      if (root === null) return [];
      const target = path.resolve(root.path, relative);
      const file = path.relative(root.path, target);
      if (!file || file === ".." || file.startsWith(`..${path.sep}`) || path.isAbsolute(file))
        return [];
      return [{ root, file }];
    })[0];
    if (!found)
      return {
        ok: false,
        error:
          "Video must be in this thread's workspace or storage. Copy the clip into $BB_THREAD_STORAGE on its host.",
      };
    const { root, file } = found;
    let cache = caches.get(bb);
    if (!cache) {
      cache = new Map();
      caches.set(bb, cache);
    }
    const key = JSON.stringify([root.hostId, root.path]);
    const existing = renew ? undefined : cache.get(key);
    let lease = existing ? await existing.catch(() => null) : null;
    if (!lease || lease.expiresAtMs - Date.now() < RENEW_MARGIN_MS) {
      const fresh = bb.sdk.files.createPreview({ hostId: root.hostId, rootPath: root.path });
      cache.set(key, fresh);
      if (cache.size > 128) cache.delete(cache.keys().next().value!);
      try {
        lease = await fresh;
      } catch (cause) {
        if (cache.get(key) === fresh) cache.delete(key);
        throw cause;
      }
    }
    return {
      ok: true,
      url: `${lease.baseUrl}/${file.split(path.sep).map(encodeURIComponent).join("/")}`,
      expiresAtMs: lease.expiresAtMs,
      owned: false,
    };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** HEAD checks confinement/existence on the owning host without transferring the recording. */
export async function checkThreadVideo(
  bb: BbPluginApi,
  threadId: string,
  requested: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const source = await previewThreadVideo(bb, threadId, requested);
  if (!source.ok) return source;
  try {
    const response = await fetch(new URL(source.url, bb.server.loopbackBaseUrl), {
      method: "HEAD",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok
      ? { ok: true }
      : { ok: false, error: `Video could not be read (HTTP ${response.status}).` };
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}
