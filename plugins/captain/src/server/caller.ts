import type { BbPluginApi, PluginCliContext } from "@get-bb/plugin-sdk";
import { isAbsolute, resolve } from "node:path";
import { DRIVE_FILE_MAX_BYTES } from "./drive.ts";
import { Refusal } from "./output.ts";
import type { Captain, Registry } from "./registry.ts";
import type { Store } from "./store.ts";

/**
 * Who a call acts for. The calling thread is request metadata the CLI reports,
 * not an authenticated identity, so these checks stop cooperative crew from
 * acting for their Captain by mistake, not a caller that drops its thread.
 */
export type Acting = { captain: Captain; crew: boolean };

type CallerDeps = {
  bb: Pick<BbPluginApi, "sdk">;
  registry: Registry;
  store: Pick<Store, "captain" | "crewRole">;
};

/**
 * What a calling thread is to Captain: a live Captain, crew of a Captain
 * (live or archived), or neither. Crew are found by their bb parent, as
 * `configure` finds them, so a re-parented thread follows its new Captain.
 */
type ThreadRole =
  | { kind: "captain"; captain: Captain }
  | { kind: "crew"; captain: Captain; live: boolean }
  | { kind: "other" }
  | { kind: "unreadable"; message: string };

async function threadRole(deps: CallerDeps, threadId: string): Promise<ThreadRole> {
  const own = deps.registry.get(threadId);
  if (own !== null) return { kind: "captain", captain: own };
  let parentId: string | null;
  try {
    parentId = (await deps.bb.sdk.threads.get({ threadId })).parentThreadId ?? null;
  } catch (error) {
    return { kind: "unreadable", message: (error as Error).message };
  }
  if (parentId === null) return { kind: "other" };
  const live = deps.registry.get(parentId);
  if (live !== null) return { kind: "crew", captain: live, live: true };
  const archived = deps.store.captain(parentId);
  return archived === null ? { kind: "other" } : { kind: "crew", captain: archived, live: false };
}

/** A live Captain by thread id or name. */
function findCaptain(registry: Registry, address: string): Captain | null {
  return registry.get(address.trim()) ?? registry.byName(address);
}

function crewRefusal(threadId: string, captain: Captain, action: string): Refusal {
  return new Refusal([
    {
      reason: `${threadId} is crew of the ${captain.name} Captain; crew cannot ${action}`,
      fix: `report the need to the ${captain.name} Captain (${captain.threadId}); only it or the user can ${action}`,
    },
  ]);
}

/**
 * Refuse a call from a crew thread: a child of a Captain, or any thread ever
 * dispatched as crew, so released crew stay refused. The user's terminal, a
 * thread bb cannot read and every other thread pass.
 */
export async function refuseCrew(
  deps: CallerDeps,
  ctx: PluginCliContext,
  action: string,
): Promise<void> {
  const threadId = ctx.threadId;
  if (threadId === undefined) return;
  const recorded = deps.store.crewRole(threadId);
  const recordedCaptain = recorded === null ? null : deps.store.captain(recorded.captainId);
  if (recordedCaptain !== null) throw crewRefusal(threadId, recordedCaptain, action);
  const role = await threadRole(deps, threadId);
  if (role.kind === "crew") throw crewRefusal(threadId, role.captain, action);
}

/**
 * The Captain a command acts for. A call with no thread is the user's terminal
 * and names its Captain with `--captain`. A thread-bound call acts only for its
 * own Captain: a Captain thread for itself, and, with `crew`, a crew thread for
 * the live Captain it reports to. `--captain` may only name that same Captain;
 * every other thread is refused. `action` words the refusals, such as
 * "manage routines".
 */
export async function actingFor(
  deps: CallerDeps,
  ctx: PluginCliContext,
  options: { captain?: string; crew?: boolean; action?: string },
): Promise<Acting> {
  const action = options.action ?? "run this command";
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
    const captain = findCaptain(deps.registry, options.captain);
    if (captain === null) {
      throw new Refusal([
        {
          reason: `no live Captain is ${JSON.stringify(options.captain)}`,
          fix: "pass a Captain's thread id or name",
        },
      ]);
    }
    return { captain, crew: false };
  }
  const role = await threadRole(deps, threadId);
  if (role.kind === "unreadable") {
    throw new Refusal([
      {
        reason: `could not read the calling thread ${threadId}: ${role.message}`,
        fix: "run it from a bb thread bb knows, or from your terminal with --captain <thread-id>",
      },
    ]);
  }
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
    throw crewRefusal(threadId, captain, action);
  }
  if (
    options.captain !== undefined &&
    findCaptain(deps.registry, options.captain)?.threadId !== captain.threadId
  ) {
    throw new Refusal([
      {
        reason: `${threadId} acts only for the ${captain.name} Captain, not ${JSON.stringify(options.captain)}`,
        fix: "drop --captain, or run it from your terminal",
      },
    ]);
  }
  return { captain, crew: role.kind === "crew" };
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
