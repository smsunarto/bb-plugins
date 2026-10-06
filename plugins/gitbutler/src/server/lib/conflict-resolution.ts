import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Subthread } from "../../shared/schema.ts";
import { liveSubthread } from "./subthreads.ts";
import type { LocatedRepository } from "./subthreads.ts";

/**
 * Which subthread resolves each repository's conflicts, in plugin KV. One per
 * repository, not per branch or per thread: resolving a lower commit rebases
 * every commit above it, so two agents on one workspace would rewrite each
 * other's work. The key is the repository's place on its host, so every
 * thread whose panel shows that workspace finds the same subthread, and it
 * outlives the panel.
 */

type Entry = { threadId: string };

const kvKey = ({ hostId, path }: LocatedRepository) => `conflict-resolution:${hostId}:${path}`;

/** Claims in flight, so overlapping requests for one repository take turns. */
const claims = new Map<string, Promise<string>>();

/** The repository's subthread, unless it was archived or deleted. */
export async function readConflictResolution(
  bb: BbPluginApi,
  repository: LocatedRepository,
): Promise<Subthread | null> {
  const entry = await bb.storage.kv.get<Entry>(kvKey(repository));
  return entry ? liveSubthread(bb, entry.threadId) : null;
}

/**
 * Runs `start` with the repository's subthread, or null when it has none,
 * and records the subthread it answers. Each claim waits for the one before
 * it, so two requests that overlap still end with one subthread between them.
 * In-process only: one bb server runs the plugin.
 */
export function claimConflictResolution(
  bb: BbPluginApi,
  repository: LocatedRepository,
  start: (current: Subthread | null) => Promise<string>,
): Promise<string> {
  const key = kvKey(repository);
  const claim = (claims.get(key) ?? Promise.resolve(""))
    .catch(() => "")
    .then(async () => {
      const threadId = await start(await readConflictResolution(bb, repository));
      await bb.storage.kv.set(key, { threadId } satisfies Entry);
      return threadId;
    });
  claims.set(key, claim);
  const release = () => {
    if (claims.get(key) === claim) claims.delete(key);
  };
  claim.then(release, release);
  return claim;
}
