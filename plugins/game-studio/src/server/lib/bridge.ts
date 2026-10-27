import {
  type BridgePingResponse,
  type BridgePlacement,
  type BridgeThread,
  type BridgeThreadOutput,
  type BridgeThreadStatus,
  bridgeSpawnRequestSchema,
  bridgeThreadRequestSchema,
} from "@argus-labs/game-studio-api";
import type { BbPluginApi, JsonValue } from "@get-bb/plugin-sdk";

type JsonObject = { [key: string]: JsonValue };
type Schema = {
  parse(data: unknown): unknown;
  safeParse(
    data: unknown,
  ): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
};

/*
 * The bb bridge: the HTTP routes the Game Studio Worker calls to run agentic work on bb. The
 * Worker is the only caller; it authenticates with the per-plugin token (`bb plugin token
 * game-studio`) behind the Cloudflare Tunnel's own Access policy. Paths are exact matches under
 * /api/v1/plugins/game-studio/http, so ids travel in bodies.
 */

type Route = Parameters<BbPluginApi["http"]["route"]>[2];
type RouteContext = Parameters<Route>[0];
type ThreadRecord = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["get"]>>;

/**
 * The threads the bridge has spawned, kept in the plugin's database: the Worker may read and
 * stop those, and none of the other threads on this bb.
 */
function spawnedThreads(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec(
    "CREATE TABLE IF NOT EXISTS bridge_threads (thread TEXT PRIMARY KEY, created TEXT NOT NULL)",
  );
  return {
    add(threadId: string) {
      db.prepare("INSERT OR IGNORE INTO bridge_threads (thread, created) VALUES (?, ?)").run(
        threadId,
        new Date().toISOString(),
      );
    },
    has(threadId: string): boolean {
      return !!db.prepare("SELECT 1 FROM bridge_threads WHERE thread = ?").get(threadId);
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

/** A bb thread's state in the bridge's vocabulary. */
function bridgeStatus(thread: Pick<ThreadRecord, "status" | "archivedAt">): BridgeThreadStatus {
  if (thread.archivedAt) return "archived";
  switch (thread.status) {
    case "idle":
      return "idle";
    case "error":
      return "failed";
    case "pending":
      return "queued";
    default:
      return "active";
  }
}
const describe = (thread: ThreadRecord): BridgeThread => ({
  threadId: thread.id,
  status: bridgeStatus(thread),
  title: thread.title ?? null,
});
const gone = (error: unknown) =>
  error instanceof Error && /not found|no such thread|does not exist|deleted/i.test(error.message);

/** The machine and project a thread runs on: the placement's, else a connected machine's personal workspace. */
async function place(bb: BbPluginApi, placement: BridgePlacement) {
  const hosts = await bb.sdk.hosts.list();
  const live = hosts.filter(
    (host) => host.lifecycle.phase !== "removing" && host.lifecycle.phase !== "destroyed",
  );
  const host = placement.machine
    ? live.find((entry) => entry.id === placement.machine || entry.name === placement.machine)
    : (live.find((entry) => entry.status === "connected") ?? live[0]);
  if (!host)
    throw new Error(
      placement.machine
        ? `No bb machine is named ${placement.machine}.`
        : "No bb machine is available to run the thread.",
    );
  if (placement.rootPath) {
    // A path is only run in when bb already has an environment there: the Worker names paths
    // it was told about, and a wrong or forged one must not open a thread anywhere else.
    const known = await bb.sdk.environments.list({
      ...(placement.projectId ? { projectId: placement.projectId } : {}),
      hostId: host.id,
      path: placement.rootPath,
    });
    if (!known.some((environment) => environment.path === placement.rootPath))
      throw new Error(`bb has no checkout at ${placement.rootPath} on ${host.name}.`);
  }
  if (placement.projectId) return { hostId: host.id, projectId: placement.projectId };
  const projects = await bb.sdk.projects.list({ includePersonal: true });
  const personal = projects.find((project) => project.kind === "personal");
  if (!personal) throw new Error("bb's personal workspace is unavailable.");
  return { hostId: host.id, projectId: personal.id };
}

export function mountBridge(bb: BbPluginApi, pluginVersion: string) {
  const spawned = spawnedThreads(bb);
  const own = (threadId: string) => {
    if (!spawned.has(threadId))
      throw new Error(`Thread ${threadId} was not started by Game Studio.`);
  };
  // Typed by the schema's own `parse`, so the shared package's zod copy needs no type identity here.
  const route = <S extends Schema>(
    path: string,
    schema: S,
    handle: (input: ReturnType<S["parse"]>) => Promise<unknown>,
  ) =>
    bb.http.route(
      "POST",
      path,
      async (context: RouteContext) => {
        const parsed = schema.safeParse(await context.req.json().catch(() => null));
        if (!parsed.success)
          return json({ error: "invalid request", issues: parsed.error.issues }, 400);
        try {
          return json(await handle(parsed.data as never));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          bb.log.warn(`bridge ${path}: ${message}`);
          return json({ error: message }, 500);
        }
      },
      { auth: "token" },
    );

  bb.http.route(
    "GET",
    "/ping",
    () => json({ ok: true, pluginVersion, serverMachine: null } satisfies BridgePingResponse),
    { auth: "token" },
  );

  route("/threads/spawn", bridgeSpawnRequestSchema, async (request) => {
    const { hostId, projectId } = await place(bb, request.placement);
    const provider = request.provider;
    const thread = await bb.sdk.threads.spawn({
      projectId,
      environment: {
        type: "host",
        hostId,
        workspace: request.placement.rootPath
          ? { type: "unmanaged", path: request.placement.rootPath }
          : { type: "personal" },
      },
      visibility: request.visibility,
      ...(provider ? { providerId: provider.id } : {}),
      ...(provider?.model ? { model: provider.model } : {}),
      ...(provider?.reasoningLevel ? { reasoningLevel: provider.reasoningLevel } : {}),
      ...(provider?.serviceTier ? { serviceTier: provider.serviceTier } : {}),
      origin: "plugin",
      originPluginId: bb.pluginId,
      title: request.title,
      pluginMetadata: request.metadata as JsonObject,
      input: [
        { type: "text", mentions: [], text: request.prompt },
        ...request.images.map((url) => ({ type: "image" as const, url })),
      ],
    });
    spawned.add(thread.id);
    return describe(thread);
  });

  route("/threads/get", bridgeThreadRequestSchema, async ({ threadId }) => {
    own(threadId);
    try {
      return describe(await bb.sdk.threads.get({ threadId }));
    } catch (error) {
      if (gone(error)) return { threadId, status: "deleted", title: null } satisfies BridgeThread;
      throw error;
    }
  });

  route("/threads/output", bridgeThreadRequestSchema, async ({ threadId }) => {
    own(threadId);
    const thread = await bb.sdk.threads.get({ threadId });
    const status = bridgeStatus(thread);
    const output =
      status === "idle" || status === "archived"
        ? ((await bb.sdk.threads.output({ threadId })).output ?? null)
        : null;
    return { threadId, status, output } satisfies BridgeThreadOutput;
  });

  route("/threads/stop", bridgeThreadRequestSchema, async ({ threadId }) => {
    own(threadId);
    await bb.sdk.threads.stop({ threadId });
    return describe(await bb.sdk.threads.get({ threadId }));
  });
}
