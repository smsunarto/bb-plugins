import { HOST_TIMEOUT_MS, type VcsMethod } from "../../../shared/contracts/host-contract.ts";
import type { VcsHandle } from "../../../shared/contracts/wire.ts";
import type { LocalVcs } from "../../../shared/node/vendor/local-vcs/src/index.ts";
import { encodeArgs, hostIo, isPayloadTooLarge, unwrapResult } from "./client.ts";
import { concatenateByPaths } from "./payload-split.ts";

/** The host a proxy runs on; facades route calls that take a `LocalVcs` there. */
export const VCS_HOST = Symbol("whiteboard.vcsHost");

export type VcsProxy = LocalVcs & { readonly [VCS_HOST]: string };

export function vcsHostOf(vcs: LocalVcs): string | undefined {
  return (vcs as Partial<VcsProxy>)[VCS_HOST];
}

/**
 * A `LocalVcs` whose methods run on the repository's host through `vcsCall`
 * (design §3.1). `kind` and `rootPath` are local fields.
 */
export function vcsProxy(handle: VcsHandle, hostId: string): LocalVcs {
  const call = async (method: VcsMethod, args: unknown[]) => {
    const result = await hostIo().client.call(
      "vcsCall",
      { vcs: { kind: handle.kind, rootPath: handle.rootPath }, method, args: encodeArgs(args) },
      { hostId, timeoutMs: method === "diff" ? HOST_TIMEOUT_MS.diff : HOST_TIMEOUT_MS.default },
    );
    return unwrapResult(result, hostId);
  };

  const proxy: VcsProxy = {
    [VCS_HOST]: hostId,
    kind: handle.kind,
    rootPath: handle.rootPath,
    currentHead: () => call("currentHead", []) as ReturnType<LocalVcs["currentHead"]>,
    resolveRevision: (revision) =>
      call("resolveRevision", [revision]) as ReturnType<LocalVcs["resolveRevision"]>,
    defaultBranch: () => call("defaultBranch", []) as ReturnType<LocalVcs["defaultBranch"]>,
    mergeBase: (baseRef, headRef) =>
      call("mergeBase", [baseRef, headRef]) as ReturnType<LocalVcs["mergeBase"]>,
    listTrackedFiles: (revision) =>
      call("listTrackedFiles", revision === undefined ? [] : [revision]) as ReturnType<
        LocalVcs["listTrackedFiles"]
      >,
    readFileAtRef: (ref, relativePath) =>
      call("readFileAtRef", [ref, relativePath]) as ReturnType<LocalVcs["readFileAtRef"]>,
    diff: async (input) => {
      try {
        return (await call("diff", [input])) as string;
      } catch (error) {
        if (!isPayloadTooLarge(error)) throw error;
        const summaries = await proxy.diffFileSummaries({
          base: input.base,
          head: input.head,
          paths: input.paths,
        });
        return concatenateByPaths(
          summaries,
          async (paths) => (await call("diff", [{ ...input, paths }])) as string,
        );
      }
    },
    diffNameStatus: (input) =>
      call("diffNameStatus", [input]) as ReturnType<LocalVcs["diffNameStatus"]>,
    diffFileSummaries: (input) =>
      call("diffFileSummaries", [input]) as ReturnType<LocalVcs["diffFileSummaries"]>,
    githubRemoteSlug: () =>
      call("githubRemoteSlug", []) as ReturnType<LocalVcs["githubRemoteSlug"]>,
  };
  return proxy;
}
