import type { HostInput, HostOutput } from "../../shared/contracts/host-contract.ts";
import type { VcsHandle } from "../../shared/contracts/wire.ts";
import { type LocalVcs, detectLocalVcs } from "../../shared/node/vendor/local-vcs/src/index.ts";
import { decodeArgs, failure, hostResult } from "./codec.ts";

const handles = new Map<string, Promise<LocalVcs>>();

/** Rehydrate a `LocalVcs` handle with `detectLocalVcs`, cached per kind and rootPath. */
export function rehydrateVcs(handle: VcsHandle): Promise<LocalVcs> {
  const key = `${handle.kind}\0${handle.rootPath}`;
  let vcs = handles.get(key);
  if (!vcs) {
    vcs = detectLocalVcs(handle.rootPath).then((detected) => {
      if (!detected) throw new Error(`No Git or jj repository found for ${handle.rootPath}.`);
      return detected;
    });
    handles.set(key, vcs);
    // A failed detection (a removed checkout) is retried on the next call.
    vcs.catch(() => handles.delete(key));
  }
  return vcs;
}

/** Run one `LocalVcs` method on a rehydrated handle (design §3.1). */
export async function vcsCall(
  input: HostInput<"vcsCall">,
  _signal: AbortSignal,
): Promise<HostOutput<"vcsCall">> {
  try {
    const vcs = await rehydrateVcs(input.vcs);
    const args = await decodeArgs(input.args);
    const method = vcs[input.method] as (...args: unknown[]) => Promise<unknown>;
    return hostResult(await method.apply(vcs, args));
  } catch (error) {
    return failure(error);
  }
}
