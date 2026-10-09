import { PluginCliError } from "@bb-kit/core/command";
import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { isAbsolute, relative, resolve } from "node:path";
import type { CanvasSource } from "../../shared/source.ts";

// `bb canvas` runs on the server, but its paths belong to the agent's host.
// The server's own host is never a default: most threads run elsewhere.

type CliContext = PluginCliContext & { readonly bb: BbPluginApi };

export const hostOption = {
  type: "string",
  description: "Host ID; required outside a thread",
  placeholder: "host-id",
} as const;

/** `path` made absolute against the invoking command's directory. */
export function absolutePath(ctx: CliContext, path: string): string {
  if (isAbsolute(path)) return path;
  if (!ctx.cwd)
    throw new PluginCliError("Use absolute paths when no working directory is available");
  return resolve(ctx.cwd, path);
}

async function threadStorage(ctx: CliContext, threadId: string) {
  try {
    return await ctx.bb.sdk.threads.storageLocation({ threadId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new PluginCliError(`thread host unavailable: ${detail}`, { exitCode: 2 });
  }
}

/** `--host`, else the invoking thread's host. */
export async function invokingHostId(ctx: CliContext, host: string | undefined): Promise<string> {
  if (host) return host;
  if (!ctx.threadId)
    throw new PluginCliError("Pass --host <host-id> when running outside a thread");
  return (await threadStorage(ctx, ctx.threadId)).hostId;
}

/**
 * The canvas at `path` on the invoking agent's host. A file in the thread's
 * storage becomes the same thread-storage source the pane opens, so comment
 * writes from the CLI keep the thread's "Open canvas comments" line current.
 */
export async function cliSource(
  ctx: CliContext,
  path: string,
  host: string | undefined,
): Promise<CanvasSource> {
  const absolute = absolutePath(ctx, path);
  if (host || !ctx.threadId) {
    return { kind: "host", hostId: await invokingHostId(ctx, host), path: absolute };
  }
  const storage = await threadStorage(ctx, ctx.threadId);
  const inside = relative(storage.storageRootPath, absolute);
  if (inside !== "" && inside !== ".." && !inside.startsWith("../") && !isAbsolute(inside)) {
    return { kind: "thread-storage", threadId: ctx.threadId, path: inside };
  }
  return { kind: "host", hostId: storage.hostId, path: absolute };
}
