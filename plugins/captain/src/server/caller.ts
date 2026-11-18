import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { isAbsolute, resolve } from "node:path";
import { DRIVE_FILE_MAX_BYTES } from "./drive.ts";
import { Refusal } from "./output.ts";
import type { Captain, Registry } from "./registry.ts";

/**
 * The Captain a command acts for: `--captain <id-or-name>` when given, else the
 * calling thread when it is a Captain, else, with `crew`, the calling thread's
 * parent when that is a Captain.
 */
export async function callerCaptain(
  bb: Pick<BbPluginApi, "sdk">,
  registry: Registry,
  ctx: PluginCliContext,
  options: { captain?: string; crew?: boolean },
): Promise<Captain> {
  if (options.captain !== undefined) {
    const captain = registry.get(options.captain.trim()) ?? registry.byName(options.captain);
    if (captain !== null) return captain;
    throw new Refusal([
      {
        reason: `no live Captain is ${JSON.stringify(options.captain)}`,
        fix: "pass a Captain's thread id or name",
      },
    ]);
  }
  const threadId = ctx.threadId ?? null;
  if (threadId === null) {
    throw new Refusal([
      {
        reason: "not run from a bb thread",
        fix: "run it in the Captain thread, or pass --captain <thread-id>",
      },
    ]);
  }
  const own = registry.get(threadId);
  if (own !== null) return own;
  if (options.crew === true) {
    const { parentThreadId } = await bb.sdk.threads.get({ threadId });
    const parent = registry.get(parentThreadId ?? null);
    if (parent !== null) return parent;
  }
  throw new Refusal([
    {
      reason: `${threadId} is not a Captain${options.crew === true ? " or one of its crew" : ""}`,
      fix: "run it in the Captain thread, or pass --captain <thread-id>",
    },
  ]);
}

/** The machine a CLI call came from: the calling thread's host, else the server's. */
async function callerHostId(bb: Pick<BbPluginApi, "sdk">, ctx: PluginCliContext): Promise<string> {
  if (ctx.threadId !== undefined) {
    const { environmentId } = await bb.sdk.threads.get({ threadId: ctx.threadId });
    if (environmentId) return (await bb.sdk.environments.get({ environmentId })).hostId;
  }
  const { primaryHostId } = await bb.sdk.system.config();
  if (primaryHostId === null) {
    throw new Refusal([{ reason: "the bb server has no local machine", fix: "bb host list" }]);
  }
  return primaryHostId;
}

/**
 * Read a UTF-8 file named on the invoking machine. `run` executes on the
 * server, so a path argument is read through `bb.sdk.files` on the caller's host.
 */
export async function readCallerFile(
  bb: Pick<BbPluginApi, "sdk">,
  ctx: PluginCliContext,
  path: string,
): Promise<string> {
  const hostId = await callerHostId(bb, ctx);
  let absolute: string;
  if (isAbsolute(path)) absolute = resolve(path);
  else if (ctx.cwd !== undefined) absolute = resolve(ctx.cwd, path);
  else
    throw new Refusal([
      {
        reason: `relative path without a working directory: ${path}`,
        fix: "pass an absolute path",
      },
    ]);
  let file;
  try {
    file = await bb.sdk.files.read({ hostId, path: absolute });
  } catch (error) {
    throw new Refusal([
      {
        reason: `could not read ${absolute}: ${(error as Error).message}`,
        fix: "check the path on the calling machine",
      },
    ]);
  }
  if (file.contentEncoding !== "utf8") {
    throw new Refusal([{ reason: `${absolute} is not UTF-8 text`, fix: "pass a text file" }]);
  }
  if (Buffer.byteLength(file.content) > DRIVE_FILE_MAX_BYTES) {
    throw new Refusal([
      { reason: `${absolute} is over ${DRIVE_FILE_MAX_BYTES} bytes`, fix: "pass a smaller file" },
    ]);
  }
  return file.content;
}
