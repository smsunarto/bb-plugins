import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { isAbsolute, resolve } from "node:path";
import { DRIVE_FILE_MAX_BYTES } from "./drive.ts";
import { Refusal } from "./output.ts";
import type { Captain, Registry } from "./registry.ts";
import type { Store } from "./store.ts";

/**
 * Who a call acts as. The calling thread is request metadata the CLI reports,
 * not an authenticated identity, so these checks stop cooperative crew from
 * acting for their Captain by mistake, not a caller that drops its thread.
 */
export type Acting = { captain: Captain; as: "user" | "captain" | "crew" };

/** What a calling thread is to Captain: a live Captain, crew of a Captain (live or archived), or neither. */
type ThreadRole =
  | { kind: "captain"; captain: Captain }
  | { kind: "crew"; captain: Captain; live: boolean }
  | { kind: "other" };

async function threadRole(
  bb: Pick<BbPluginApi, "sdk">,
  registry: Registry,
  store: Pick<Store, "captain" | "crewRole">,
  threadId: string,
): Promise<ThreadRole> {
  const own = registry.get(threadId);
  if (own !== null) return { kind: "captain", captain: own };
  const parentId =
    store.crewRole(threadId)?.captainId ??
    (await bb.sdk.threads.get({ threadId })).parentThreadId ??
    null;
  if (parentId === null) return { kind: "other" };
  const live = registry.get(parentId);
  if (live !== null) return { kind: "crew", captain: live, live: true };
  const archived = store.captain(parentId);
  return archived === null ? { kind: "other" } : { kind: "crew", captain: archived, live: false };
}

/** A `--captain` value as a live Captain, or a refusal. */
function namedCaptain(registry: Registry, address: string): Captain {
  const captain = registry.get(address.trim()) ?? registry.byName(address);
  if (captain !== null) return captain;
  throw new Refusal([
    {
      reason: `no live Captain is ${JSON.stringify(address)}`,
      fix: "pass a Captain's thread id or name",
    },
  ]);
}

/**
 * The Captain a command acts for, and as whom. A call with no thread is the
 * user's terminal and names its Captain with `--captain`. A thread-bound call
 * acts only for its own Captain: a Captain thread for itself, and, with
 * `crew`, a crew thread for the Captain it reports to. `--captain` can only
 * name that same Captain; every other thread is refused.
 */
export async function actingFor(
  deps: {
    bb: Pick<BbPluginApi, "sdk">;
    registry: Registry;
    store: Pick<Store, "captain" | "crewRole">;
  },
  ctx: PluginCliContext,
  options: { captain?: string; crew?: boolean },
): Promise<Acting> {
  const threadId = ctx.threadId ?? null;
  if (threadId === null) {
    if (options.captain === undefined) {
      throw new Refusal([
        {
          reason: "not run from a bb thread",
          fix: "run it in the Captain thread, or pass --captain <thread-id>",
        },
      ]);
    }
    return { captain: namedCaptain(deps.registry, options.captain), as: "user" };
  }
  const role = await threadRole(deps.bb, deps.registry, deps.store, threadId);
  if (role.kind === "other") {
    throw new Refusal([
      {
        reason: `${threadId} is not a Captain${options.crew === true ? " or one of its crew" : ""}`,
        fix: "run it in the Captain thread, or from your terminal with --captain <thread-id>",
      },
    ]);
  }
  const { captain } = role;
  if (role.kind === "crew" && (options.crew !== true || !role.live)) {
    throw new Refusal([
      {
        reason: `${threadId} is crew of the ${captain.name} Captain; crew cannot run this command`,
        fix: `report the need to the ${captain.name} Captain (${captain.threadId}); only it or the user runs it`,
      },
    ]);
  }
  if (options.captain !== undefined) {
    const named =
      deps.registry.get(options.captain.trim()) ?? deps.registry.byName(options.captain);
    if (named === null || named.threadId !== captain.threadId) {
      throw new Refusal([
        {
          reason: `${threadId} acts only for the ${captain.name} Captain, not ${JSON.stringify(options.captain)}`,
          fix: "drop --captain, or run it from your terminal",
        },
      ]);
    }
  }
  return { captain, as: role.kind };
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

/**
 * The Captain a routine command acts for. Routines are the user's to set, so a
 * call bound to a thread is allowed only from a Captain's own thread, for its
 * own routines; `--captain` cannot point it elsewhere. A call with no thread
 * (the user's terminal) names its Captain with `--captain`.
 */
export async function routineCaptain(
  bb: Pick<BbPluginApi, "sdk">,
  registry: Registry,
  store: Pick<Store, "captain" | "crewRole">,
  ctx: PluginCliContext,
  captainOption: string | undefined,
): Promise<Captain> {
  if (ctx.threadId === undefined) {
    return (await actingFor({ bb, registry, store }, ctx, { captain: captainOption })).captain;
  }
  const own = await threadCaptain(bb, registry, store, ctx.threadId);
  if (captainOption !== undefined) {
    const named = registry.get(captainOption.trim()) ?? registry.byName(captainOption);
    if (named === null || named.threadId !== own.threadId) {
      throw new Refusal([
        {
          reason: `${own.name} Captain manages only its own routines, not ${JSON.stringify(captainOption)}'s`,
          fix: "drop --captain, or run it from your terminal",
        },
      ]);
    }
  }
  return own;
}

/** Refuse a thread-bound call for a routine of another Captain; a call with no thread passes. */
export async function routineThreadAllowed(
  bb: Pick<BbPluginApi, "sdk">,
  registry: Registry,
  store: Pick<Store, "captain" | "crewRole">,
  ctx: PluginCliContext,
  captainId: string,
): Promise<void> {
  if (ctx.threadId === undefined) return;
  const own = await threadCaptain(bb, registry, store, ctx.threadId);
  if (own.threadId === captainId) return;
  throw new Refusal([
    {
      reason: `${own.name} Captain manages only its own routines`,
      fix: "run it in the routine's Captain thread, or from your terminal",
    },
  ]);
}

/** The calling thread as a live Captain; crew and every other thread are refused. */
async function threadCaptain(
  bb: Pick<BbPluginApi, "sdk">,
  registry: Registry,
  store: Pick<Store, "captain" | "crewRole">,
  threadId: string,
): Promise<Captain> {
  const role = await threadRole(bb, registry, store, threadId);
  if (role.kind === "captain") return role.captain;
  if (role.kind === "crew") {
    const parent = role.captain;
    throw new Refusal([
      {
        reason: `${threadId} is crew of the ${parent.name} Captain; crew cannot manage routines`,
        fix: `report the need to the ${parent.name} Captain (${parent.threadId}); only it or the user sets routines`,
      },
    ]);
  }
  throw new Refusal([
    {
      reason: `${threadId} is not a Captain; only a Captain's own thread or the user's terminal manages routines`,
      fix: "run it in the Captain thread, or from your terminal with --captain <thread-id>",
    },
  ]);
}
