import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createMemo, type Memo } from "../../shared/memo.ts";

/**
 * Every checkout path bb knows, by machine: project sources and ready
 * environments. bb does not know which repository each one holds: a
 * project's source on one machine can be another repository entirely, so a
 * machine's host sorts that out.
 */
export async function knownCheckoutPaths(bb: BbPluginApi) {
  const [hosts, projects, environments] = await Promise.all([
    bb.sdk.hosts.list(),
    bb.sdk.projects.list(),
    bb.sdk.environments.list({ status: "ready" }),
  ]);
  const paths = new Map<string, Set<string>>();
  const add = (hostId: string, path: string | null) => {
    if (!path) return;
    const known = paths.get(hostId) ?? new Set<string>();
    known.add(path);
    paths.set(hostId, known);
  };
  for (const project of projects) {
    for (const source of project.sources) add(source.hostId, source.path);
  }
  for (const environment of environments) add(environment.hostId, environment.path);
  /** The connected machines that hold any of them, with their paths. */
  return hosts.flatMap((host) => {
    const known = paths.get(host.id);
    return host.status === "connected" && known ? [{ host, paths: [...known] }] : [];
  });
}

/** How long a file preview's reads reuse the checkout paths: one preview is many calls. */
const RECENT_MS = 5_000;
const recent = new WeakMap<BbPluginApi, Memo>();

/** {@link knownCheckoutPaths}, shared by the reads of one file preview. */
export function recentCheckoutPaths(bb: BbPluginApi): ReturnType<typeof knownCheckoutPaths> {
  let memo = recent.get(bb);
  if (!memo) {
    memo = createMemo({ ttlMs: RECENT_MS });
    recent.set(bb, memo);
  }
  return memo.read("paths", () => knownCheckoutPaths(bb));
}
