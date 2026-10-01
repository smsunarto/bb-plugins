import type { LocalVcs } from "../../../shared/node/vendor/local-vcs/src/index.ts";
import type * as upstream from "../../../shared/node/vendor/review/src/review-api/worktree-source.ts";
import { type HostRoute, invokeHost } from "./client.ts";
import { vcsHostOf } from "./vcs-proxy.ts";

/**
 * Server facade for `review-api/worktree-source` (design §3.1). Each export
 * runs whole on the checkout's host: `inspectWorktree` and `workingFiles`
 * stat every working file, which must stay one hop.
 */
export { EMPTY_SOURCE } from "../../../shared/node/vendor/review/src/review-api/worktree-source.ts";

/** A proxy runs where it was detected; any other `LocalVcs` routes by its root. */
const onVcs = (vcs: LocalVcs): HostRoute => {
  const hostId = vcsHostOf(vcs);
  return hostId ? { hostId } : { rootPath: vcs.rootPath };
};

export const localSourcePath: typeof upstream.localSourcePath = async (root, file) =>
  (await invokeHost("worktree-source", "localSourcePath", [root, file], {
    rootPath: root,
  })) as string;

export const workingFiles: typeof upstream.workingFiles = async (vcs) =>
  (await invokeHost("worktree-source", "workingFiles", [vcs], onVcs(vcs))) as string[];

export const inspectWorktree: typeof upstream.inspectWorktree = async (repositoryId, vcs) =>
  (await invokeHost("worktree-source", "inspectWorktree", [repositoryId, vcs], onVcs(vcs))) as {
    revision: string;
    commit: string;
  };

export const readWorkingFile: typeof upstream.readWorkingFile = async (root, file) =>
  (await invokeHost("worktree-source", "readWorkingFile", [root, file], { rootPath: root })) as
    | string
    | null;
