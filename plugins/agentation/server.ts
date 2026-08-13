// @smsunarto/bb-plugin-agentation — backend.
//
// The browser toolbar is the only writer of annotation bodies; this backend is
// the durable store, the agent-facing surface, and the change bus that pushes
// agent decisions back to every open bb window.
//
// Wire surfaces, and why each exists:
//   rpc            the toolbar content script and the review panel both talk here
//   GET /events    server-sent events, so a resolve lands in the browser at once
//   agent tools    the loop an agent actually runs (pending → fix → resolve)
//   bb agentation  the same loop for agents that prefer a shell

import { defineRpcContract, type BbPluginApi } from "@bb/plugin-sdk";
import { z } from "zod";

import {
  type AnnotationStatus,
  type SessionStatus,
  annotationRoutingSchema,
  annotationSchema,
  annotationStatuses,
  bbContextSchema,
  sanitizeJson,
  sessionSchema,
  sessionSummarySchema,
  storedAnnotationSchema,
} from "./lib/afs.ts";
import { projectIdFromRoute, threadIdFromRoute } from "./lib/route.ts";
import {
  renderAnnotation,
  renderAnnotationAssignment,
  renderAnnotationLine,
  renderAnnotations,
} from "./lib/markdown.ts";
import {
  appendThreadMessage,
  clearSession,
  countByStatus,
  currentSeq,
  deleteAnnotations,
  getAnnotation,
  getSession,
  listAnnotations,
  listSessions,
  migrations,
  openSession,
  pruneClosed,
  sessionCursor,
  setAnnotationStatus,
  upsertAnnotation,
} from "./lib/store.ts";
import {
  claimStagedAnnotations,
  completeDispatch,
  discardStagedAnnotations,
  failDispatch,
  getAnnotationRouting,
  listAnnotationRoutings,
  listStagedAnnotations,
  recoverInterruptedDispatches,
  restageAnnotation as restageStoredAnnotation,
} from "./lib/staging.ts";

const openStatuses: AnnotationStatus[] = ["pending", "acknowledged"];

const configSchema = z.object({
  toolbarEnabled: z.boolean(),
});

export const rpcContract = defineRpcContract({
  // --- toolbar content script -------------------------------------------
  openSession: {
    input: z
      .object({
        url: z.string(),
        route: z.string(),
        title: z.string().nullable(),
        threadId: z.string().nullable(),
        projectId: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      session: sessionSchema,
      annotations: z.array(storedAnnotationSchema),
      cursor: z.number().int(),
      config: configSchema,
    }),
  },
  pushAnnotations: {
    input: z
      .object({
        sessionId: z.string(),
        upserts: z.array(
          z.object({ annotation: annotationSchema, bb: bbContextSchema }),
        ),
        deletedIds: z.array(z.string()),
      })
      .strict(),
    output: z.object({
      cursor: z.number().int(),
      annotations: z.array(storedAnnotationSchema),
    }),
  },
  pullSession: {
    input: z
      .object({ sessionId: z.string(), cursor: z.number().int() })
      .strict(),
    output: z.object({
      cursor: z.number().int(),
      changed: z.boolean(),
      annotations: z.array(storedAnnotationSchema),
      config: configSchema,
    }),
  },
  clearSessionAnnotations: {
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ cursor: z.number().int(), removed: z.number().int() }),
  },
  listStagedAnnotations: {
    input: z.null(),
    output: z.object({ annotations: z.array(storedAnnotationSchema) }),
  },
  discardStagedAnnotations: {
    input: z
      .object({ annotationIds: z.array(z.string()).min(1) })
      .strict(),
    output: z.object({
      outcome: z.enum(["discarded", "stale"]),
      discardedIds: z.array(z.string()),
      remainingCount: z.number().int(),
      message: z.string(),
    }),
  },
  sendStagedAnnotations: {
    input: z
      .object({
        annotationIds: z.array(z.string()).min(1),
        threadId: z.string().min(1),
      })
      .strict(),
    output: z.object({
      outcome: z.enum(["sent", "stale"]),
      sentIds: z.array(z.string()),
      remainingCount: z.number().int(),
      message: z.string(),
    }),
  },
  restageAnnotation: {
    input: z.object({ annotationId: z.string() }).strict(),
    output: z.object({ routing: annotationRoutingSchema.nullable() }),
  },

  // --- review panel ------------------------------------------------------
  getConfig: {
    input: z.null(),
    output: z.object({
      config: configSchema,
      counts: z.object({
        pending: z.number().int(),
        acknowledged: z.number().int(),
        resolved: z.number().int(),
        dismissed: z.number().int(),
        total: z.number().int(),
      }),
    }),
  },
  setToolbarEnabled: {
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ toolbarEnabled: z.boolean() }),
  },
  listSessions: {
    input: z.object({ status: z.enum(["active"]).nullable() }).strict(),
    output: z.object({ sessions: z.array(sessionSummarySchema) }),
  },
  listAnnotations: {
    input: z
      .object({
        sessionId: z.string().nullable(),
        statuses: z.array(z.enum(annotationStatuses)).nullable(),
        pluginId: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      annotations: z.array(storedAnnotationSchema),
      routings: z.record(z.string(), annotationRoutingSchema),
    }),
  },
  mutateAnnotation: {
    input: z
      .object({
        annotationId: z.string(),
        action: z.enum([
          "acknowledge",
          "resolve",
          "dismiss",
          "reopen",
          "delete",
        ]),
        note: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      annotation: storedAnnotationSchema.nullable(),
      deleted: z.boolean(),
    }),
  },
  replyToAnnotation: {
    input: z
      .object({ annotationId: z.string(), message: z.string().min(1) })
      .strict(),
    output: z.object({ annotation: storedAnnotationSchema.nullable() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    retentionDays: {
      type: "string",
      label: "Days to keep resolved annotations",
      default: "7",
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);

  const recoveredDispatches = recoverInterruptedDispatches(db);
  if (recoveredDispatches > 0) {
    bb.log.warn(
      `re-staged ${recoveredDispatches} annotations interrupted during delivery`,
    );
  }

  // Whether the toolbar is showing is live state, not configuration: it is
  // toggled from the panel and the CLI mid-session, and plugin settings are
  // read-only from a handler. So it lives in kv, where a handler can write it.
  const TOOLBAR_KEY = "toolbar-enabled";

  async function isToolbarEnabled(): Promise<boolean> {
    return (await bb.storage.kv.get<boolean>(TOOLBAR_KEY)) ?? true;
  }

  async function readConfig(): Promise<z.infer<typeof configSchema>> {
    return {
      toolbarEnabled: await isToolbarEnabled(),
    };
  }

  // -------------------------------------------------------------------------
  // Change bus
  //
  // Three consumers care about a write: the review panel (bb realtime), every
  // open toolbar (server-sent events), and any agent parked in
  // `agentation_watch_annotations`.
  // -------------------------------------------------------------------------

  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const heartbeats = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    ReturnType<typeof setInterval>
  >();
  const watchers = new Set<() => void>();
  const encoder = new TextEncoder();
  let disposed = false;

  function broadcast(event: { type: string; sessionId: string | null }): void {
    const payload = {
      ...event,
      cursor: currentSeq(db),
      at: new Date().toISOString(),
    };

    bb.realtime.publish("annotations", payload);

    const frame = encoder.encode(
      `event: change\ndata: ${JSON.stringify(payload)}\n\n`,
    );
    // Both loops may delete the entry they are standing on — well defined for
    // a Set, and nothing here removes any other entry.
    for (const controller of streams) {
      try {
        controller.enqueue(frame);
      } catch {
        dropStream(controller);
      }
    }

    for (const wake of watchers) wake();
  }

  function dropStream(
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): void {
    const heartbeat = heartbeats.get(controller);
    if (heartbeat) clearInterval(heartbeat);
    heartbeats.delete(controller);
    streams.delete(controller);
  }

  // Responses are built through the Hono context rather than `new Response`:
  // the host checks `instanceof Response` against its own realm, and only the
  // context's constructor is guaranteed to be the same one.
  bb.http.route("GET", "/events", (c) => {
    let self: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        streams.add(controller);
        controller.enqueue(
          encoder.encode(
            `event: hello\ndata: ${JSON.stringify({ cursor: currentSeq(db) })}\n\n`,
          ),
        );
        // An idle stream gets dropped by proxies and by the tunnel used for
        // remote bb access; a comment frame is the cheapest thing that keeps
        // it open and costs the client nothing to parse.
        heartbeats.set(
          controller,
          setInterval(() => {
            try {
              controller.enqueue(encoder.encode(`: ping\n\n`));
            } catch {
              dropStream(controller);
            }
          }, 25_000),
        );
      },
      cancel() {
        if (self) dropStream(self);
      },
    });

    return c.newResponse(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });

  bb.http.route("GET", "/health", (c) =>
    c.json({
      ok: true,
      pluginId: bb.pluginId,
      cursor: currentSeq(db),
      counts: countByStatus(db),
    }),
  );

  // -------------------------------------------------------------------------
  // Thread delivery
  // -------------------------------------------------------------------------

  async function sendStagedToThread(
    annotationIds: string[],
    threadId: string,
  ): Promise<{
    outcome: "sent" | "stale";
    sentIds: string[];
    remainingCount: number;
    message: string;
  }> {
    const claim = claimStagedAnnotations(db, { annotationIds, threadId });
    if (claim.outcome === "stale") {
      const remainingCount = listStagedAnnotations(db).length;
      return {
        outcome: "stale",
        sentIds: [],
        remainingCount,
        message: "The staged annotations changed. Review the current batch and send it again.",
      };
    }

    broadcast({ type: "routing", sessionId: null });

    const instruction = renderAnnotationAssignment(
      claim.dispatch.annotations,
      listSessions(db, {}),
    );

    try {
      await bb.sdk.threads.send({
        threadId,
        mode: "auto",
        input: [{ type: "text", text: instruction, mentions: [] }],
      });

      completeDispatch(db, claim.dispatch.id);
      broadcast({ type: "routing", sessionId: null });
      bb.log.info(
        `assigned ${claim.dispatch.annotations.length} staged annotations to ${threadId}`,
      );

      return {
        outcome: "sent",
        sentIds: claim.dispatch.annotations.map((annotation) => annotation.id),
        remainingCount: listStagedAnnotations(db).length,
        message: `Sent ${claim.dispatch.annotations.length} annotation${claim.dispatch.annotations.length === 1 ? "" : "s"} to this thread.`,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failDispatch(db, claim.dispatch.id, detail);
      broadcast({ type: "routing", sessionId: null });
      bb.log.warn(`delivery to ${threadId} failed: ${detail}`);
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // rpc
  // -------------------------------------------------------------------------

  bb.rpc.register(rpcContract, {
    async openSession(input) {
      const session = openSession(db, {
        url: input.url,
        route: input.route,
        title: input.title,
        threadId: input.threadId ?? threadIdFromRoute(input.route),
        projectId: input.projectId ?? projectIdFromRoute(input.route),
      });
      return sanitizeJson({
        session,
        annotations: listAnnotations(db, {
          sessionId: session.id,
          limit: null,
        }),
        cursor: sessionCursor(db, session.id),
        config: await readConfig(),
      });
    },

    pushAnnotations(input) {
      // A long-lived bb window caches its session id. The nightly prune can
      // remove an empty session out from under it, and there is no foreign key
      // to stop the write — the annotations would land against a session that
      // no longer exists and disappear from the review panel. Fail instead, so
      // the client drops the stale id and opens a fresh session.
      if (!getSession(db, input.sessionId)) {
        throw new Error(`unknown session ${input.sessionId}`);
      }
      for (const item of input.upserts) {
        upsertAnnotation(db, {
          sessionId: input.sessionId,
          annotation: item.annotation,
          bb: item.bb,
        });
      }
      if (input.deletedIds.length > 0) {
        deleteAnnotations(db, input.deletedIds);
      }
      if (input.upserts.length > 0 || input.deletedIds.length > 0) {
        broadcast({ type: "annotations", sessionId: input.sessionId });
      }
      return sanitizeJson({
        cursor: sessionCursor(db, input.sessionId),
        annotations: listAnnotations(db, {
          sessionId: input.sessionId,
          limit: null,
        }),
      });
    },

    async pullSession(input) {
      const cursor = sessionCursor(db, input.sessionId);
      return sanitizeJson({
        cursor,
        changed: cursor > input.cursor,
        annotations: listAnnotations(db, {
          sessionId: input.sessionId,
          limit: null,
        }),
        config: await readConfig(),
      });
    },

    clearSessionAnnotations(input) {
      const removed = clearSession(db, input.sessionId);
      broadcast({ type: "annotations", sessionId: input.sessionId });
      return { cursor: sessionCursor(db, input.sessionId), removed };
    },

    listStagedAnnotations() {
      return sanitizeJson({ annotations: listStagedAnnotations(db) });
    },

    discardStagedAnnotations(input) {
      const result = discardStagedAnnotations(db, input.annotationIds);
      const remainingCount = listStagedAnnotations(db).length;
      if (result.outcome === "stale") {
        return {
          outcome: "stale" as const,
          discardedIds: [],
          remainingCount,
          message:
            "The staged annotations changed. Review the current batch and discard it again.",
        };
      }

      broadcast({ type: "annotations", sessionId: null });

      const discardedIds = result.annotations.map(
        (annotation) => annotation.id,
      );
      return {
        outcome: "discarded" as const,
        discardedIds,
        remainingCount,
        message: `Discarded ${discardedIds.length} annotation${discardedIds.length === 1 ? "" : "s"}.`,
      };
    },

    async sendStagedAnnotations(input) {
      return sanitizeJson(
        await sendStagedToThread(input.annotationIds, input.threadId),
      );
    },

    restageAnnotation(input) {
      const routing = restageStoredAnnotation(db, input.annotationId);
      if (routing) broadcast({ type: "routing", sessionId: null });
      return sanitizeJson({ routing });
    },

    async getConfig() {
      return { config: await readConfig(), counts: countByStatus(db) };
    },

    async setToolbarEnabled(input) {
      await bb.storage.kv.set(TOOLBAR_KEY, input.enabled);
      broadcast({ type: "config", sessionId: null });
      return { toolbarEnabled: input.enabled };
    },

    listSessions(input) {
      return sanitizeJson({
        sessions: listSessions(db, {
          status: (input.status as SessionStatus | null) ?? undefined,
        }),
      });
    },

    listAnnotations(input) {
      const annotations = listAnnotations(db, {
        sessionId: input.sessionId ?? undefined,
        statuses: input.statuses ?? undefined,
        pluginId: input.pluginId ?? undefined,
      });

      return sanitizeJson({
        annotations,
        routings: listAnnotationRoutings(
          db,
          annotations.map((annotation) => annotation.id),
        ),
      });
    },

    mutateAnnotation(input) {
      if (input.action === "delete") {
        const existing = getAnnotation(db, input.annotationId);
        deleteAnnotations(db, [input.annotationId]);
        broadcast({
          type: "annotations",
          sessionId: existing?.sessionId ?? null,
        });
        return { annotation: null, deleted: existing !== null };
      }

      const status: AnnotationStatus =
        input.action === "acknowledge"
          ? "acknowledged"
          : input.action === "resolve"
            ? "resolved"
            : input.action === "dismiss"
              ? "dismissed"
              : "pending";

      const annotation = setAnnotationStatus(db, {
        annotationId: input.annotationId,
        status,
        by: "human",
        resolution: input.note,
      });
      if (annotation) {
        broadcast({ type: "annotations", sessionId: annotation.sessionId });
      }
      return sanitizeJson({ annotation, deleted: false });
    },

    async replyToAnnotation(input) {
      const existing = getAnnotation(db, input.annotationId);
      if (!existing) return sanitizeJson({ annotation: null });

      const routing = getAnnotationRouting(db, input.annotationId);
      if (routing?.state !== "assigned" || !routing.assignedThreadId) {
        throw new Error(
          "Stage and send this annotation to a thread before you reply.",
        );
      }

      const context = renderAnnotation(existing);
      await bb.sdk.threads.send({
        threadId: routing.assignedThreadId,
        mode: "auto",
        input: [
          {
            type: "text",
            text: `# Agentation follow-up\n\n${context}\n\n## Human reply\n\n${input.message}`,
            mentions: [],
          },
        ],
      });

      const annotation = appendThreadMessage(db, input.annotationId, {
        role: "human",
        content: input.message,
      });
      if (annotation) {
        broadcast({ type: "annotations", sessionId: annotation.sessionId });
      }
      return sanitizeJson({ annotation });
    },
  });

  // -------------------------------------------------------------------------
  // Agent tools
  //
  // Names mirror the upstream agentation MCP server, so prompts and skills
  // written for it work unchanged against a bb thread — with no MCP process to
  // configure, because bb hands these to whichever provider the thread runs.
  // -------------------------------------------------------------------------

  function toolText(text: string): string {
    return text;
  }

  bb.agents.registerTool({
    name: "agentation_list_sessions",
    description:
      "List annotation sessions — one per bb page a human has left visual feedback on. Start here to discover which pages have feedback.",
    experimental_statusLabels: {
      pending: "Listing annotation sessions",
      completed: "Listed annotation sessions",
    },
    parameters: z.object({}),
    execute() {
      const sessions = listSessions(db, {});
      if (sessions.length === 0) return toolText("No annotation sessions yet.");
      return toolText(
        sessions
          .map(
            (session) =>
              `${session.id}  ${session.route}  pending=${session.counts.pending} acknowledged=${session.counts.acknowledged} resolved=${session.counts.resolved}`,
          )
          .join("\n"),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_get_session",
    description:
      "Get one annotation session with every annotation on it, including resolved and dismissed ones.",
    experimental_statusLabels: {
      pending: "Reading annotation session",
      completed: "Read annotation session",
    },
    parameters: z.object({ sessionId: z.string() }),
    execute({ sessionId }) {
      const session = getSession(db, sessionId);
      if (!session) return toolText(`No session ${sessionId}.`);
      return toolText(
        renderAnnotations(listAnnotations(db, { sessionId }), {
          title: `Session ${sessionId}`,
          sessions: [session],
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_get_pending",
    description:
      "Get the open (pending or acknowledged) annotations for one session, rendered with the bb route, owning plugin, and DOM selector for each.",
    experimental_statusLabels: {
      pending: "Reading pending annotations",
      completed: "Read pending annotations",
    },
    parameters: z.object({ sessionId: z.string() }),
    execute({ sessionId }) {
      const session = getSession(db, sessionId);
      return toolText(
        renderAnnotations(
          listAnnotations(db, { sessionId, statuses: openStatuses }),
          {
            title: `Open annotations in ${sessionId}`,
            sessions: session ? [session] : [],
          },
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_get_all_pending",
    description:
      "Get every open annotation across all bb pages. Use this when the human refers to UI feedback but did not supply a self-contained Agentation annotation batch.",
    instructions:
      "When the human refers to feedback they left on the bb interface and their message does not already contain an Agentation annotation batch, read it with agentation_get_all_pending before searching the code. A supplied batch is self-contained; do not fetch other pending feedback. Each annotation names the bb route and, for plugin surfaces, the owning plugin id.",
    experimental_statusLabels: {
      pending: "Reading all pending annotations",
      completed: "Read all pending annotations",
    },
    parameters: z.object({
      pluginId: z
        .string()
        .optional()
        .describe("Only annotations on this plugin's UI surfaces."),
    }),
    execute({ pluginId }) {
      return toolText(
        renderAnnotations(
          listAnnotations(db, { statuses: openStatuses, pluginId }),
          {
            title: "Open bb UI feedback",
            sessions: listSessions(db, {}),
          },
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_acknowledge",
    description:
      "Mark an annotation as acknowledged so the human can see you have picked it up.",
    experimental_statusLabels: {
      pending: "Acknowledging annotation",
      completed: "Acknowledged annotation",
    },
    parameters: z.object({ annotationId: z.string() }),
    execute({ annotationId }) {
      const annotation = setAnnotationStatus(db, {
        annotationId,
        status: "acknowledged",
        by: "agent",
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Acknowledged ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_resolve",
    description:
      "Mark an annotation as resolved after you have fixed it. The marker disappears from the human's toolbar. Include a short summary of what changed.",
    experimental_statusLabels: {
      pending: "Resolving annotation",
      completed: "Resolved annotation",
    },
    parameters: z.object({
      annotationId: z.string(),
      summary: z.string().optional(),
    }),
    execute({ annotationId, summary }) {
      const annotation = setAnnotationStatus(db, {
        annotationId,
        status: "resolved",
        by: "agent",
        resolution: summary ?? null,
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Resolved ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_dismiss",
    description:
      "Dismiss an annotation you have decided not to act on. A reason is required — the human sees it.",
    experimental_statusLabels: {
      pending: "Dismissing annotation",
      completed: "Dismissed annotation",
    },
    parameters: z.object({ annotationId: z.string(), reason: z.string() }),
    execute({ annotationId, reason }) {
      const annotation = setAnnotationStatus(db, {
        annotationId,
        status: "dismissed",
        by: "agent",
        resolution: reason,
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Dismissed ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_reply",
    description:
      "Add a message to an annotation's thread — ask a clarifying question, or report progress. The human reads and answers it in the Agentation panel.",
    experimental_statusLabels: {
      pending: "Replying to annotation",
      completed: "Replied to annotation",
    },
    parameters: z.object({ annotationId: z.string(), message: z.string() }),
    execute({ annotationId, message }) {
      const annotation = appendThreadMessage(db, annotationId, {
        role: "agent",
        content: message,
      });
      if (!annotation) return toolText(`No annotation ${annotationId}.`);
      broadcast({ type: "annotations", sessionId: annotation.sessionId });
      return toolText(`Replied on ${annotationId}.`);
    },
  });

  bb.agents.registerTool({
    name: "agentation_watch_annotations",
    description:
      "Block until new annotations appear, then return the batch. Call it in a loop for hands-free feedback: watch, fix, resolve, watch again.",
    experimental_statusLabels: {
      pending: "Watching for new annotations",
      completed: "Collected new annotations",
    },
    parameters: z.object({
      sessionId: z
        .string()
        .optional()
        .describe("Only watch one page's session."),
      batchWindowSeconds: z
        .number()
        .int()
        .min(0)
        .max(60)
        .optional()
        .describe(
          "After the first new annotation, keep collecting for this long. Default 10.",
        ),
      timeoutSeconds: z
        .number()
        .int()
        .min(1)
        .max(300)
        .optional()
        .describe("Give up after this long with nothing new. Default 120."),
    }),
    async execute({ sessionId, batchWindowSeconds, timeoutSeconds }, context) {
      const batchWindowMs = (batchWindowSeconds ?? 10) * 1000;
      const timeoutMs = (timeoutSeconds ?? 120) * 1000;
      const startCursor = currentSeq(db);

      const fresh = () =>
        listAnnotations(db, {
          sessionId,
          statuses: openStatuses,
          sinceSeq: startCursor,
        });

      const appeared = await waitForChange(timeoutMs, context.signal, () =>
        fresh().length > 0,
      );
      if (!appeared) {
        return toolText(
          "No new annotations before the timeout. Call agentation_watch_annotations again to keep waiting.",
        );
      }

      if (batchWindowMs > 0) {
        await sleep(batchWindowMs, context.signal);
      }

      const batch = fresh();
      return toolText(
        renderAnnotations(batch, {
          title: `${batch.length} new annotation${batch.length === 1 ? "" : "s"}`,
          sessions: listSessions(db, {}),
        }),
      );
    },
  });

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Resolve true as soon as `test()` passes, false on timeout or abort. */
  function waitForChange(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    test: () => boolean,
  ): Promise<boolean> {
    if (test()) return Promise.resolve(true);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        watchers.delete(wake);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const wake = () => {
        if (test()) finish(true);
      };
      const onAbort = () => finish(false);

      const timer = setTimeout(() => finish(false), timeoutMs);
      watchers.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (disposed) finish(false);
    });
  }

  bb.agents.contributeInstructions(() => {
    try {
      const pending = countByStatus(db).pending;
      if (pending === 0) return null;
      return `The human has ${pending} unresolved Agentation annotation${pending === 1 ? "" : "s"} on the bb interface. Before acting on a request about the bb UI, call agentation_get_all_pending only when the request does not already contain an Agentation annotation batch. A supplied batch is self-contained; work only on its listed annotation IDs. Resolve each annotation you fix.`;
    } catch {
      return null;
    }
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  bb.cli.register({
    name: "agentation",
    summary: "Read and resolve visual feedback left on the bb interface",
    commands: [
      {
        name: "pending",
        summary: "Show every open annotation",
        usage: "bb agentation pending [--plugin <id>] [--json]",
      },
      {
        name: "staged",
        summary: "Show annotations waiting for a thread",
        usage: "bb agentation staged [--json]",
      },
      {
        name: "send",
        summary: "Assign staged annotations to a thread",
        usage: "bb agentation send <threadId> [annotationId…]",
      },
      {
        name: "restage",
        summary: "Return an assigned annotation to staging",
        usage: "bb agentation restage <annotationId>",
      },
      {
        name: "sessions",
        summary: "List annotated pages",
        usage: "bb agentation sessions",
      },
      {
        name: "show",
        summary: "Show one annotation in full",
        usage: "bb agentation show <annotationId>",
      },
      {
        name: "acknowledge",
        summary: "Mark an annotation as seen",
        usage: "bb agentation acknowledge <annotationId>",
      },
      {
        name: "resolve",
        summary: "Mark an annotation as fixed",
        usage: "bb agentation resolve <annotationId> [summary…]",
      },
      {
        name: "dismiss",
        summary: "Decline an annotation, with a reason",
        usage: "bb agentation dismiss <annotationId> <reason…>",
      },
      {
        name: "reply",
        summary: "Ask the human a question on an annotation",
        usage: "bb agentation reply <annotationId> <message…>",
      },
      {
        name: "toolbar",
        summary: "Show or set whether the annotation toolbar is displayed",
        usage: "bb agentation toolbar [on|off]",
      },
    ],
    async run(argv) {
      const [command, ...rest] = argv;
      const flagIndex = rest.indexOf("--plugin");
      const pluginId =
        flagIndex >= 0 ? (rest[flagIndex + 1] ?? undefined) : undefined;
      const json = rest.includes("--json");
      const positional = rest.filter(
        (value, index) =>
          !value.startsWith("--") &&
          !(flagIndex >= 0 && index === flagIndex + 1),
      );

      const ok = (stdout: string) => ({ exitCode: 0, stdout });
      const fail = (stderr: string) => ({ exitCode: 1, stderr });

      switch (command) {
        case undefined:
        case "help":
          return ok(
            [
              "bb agentation pending [--plugin <id>] [--json]",
              "bb agentation staged [--json]",
              "bb agentation send <threadId> [annotationId…]",
              "bb agentation restage <annotationId>",
              "bb agentation sessions",
              "bb agentation show <annotationId>",
              "bb agentation acknowledge <annotationId>",
              "bb agentation resolve <annotationId> [summary…]",
              "bb agentation dismiss <annotationId> <reason…>",
              "bb agentation reply <annotationId> <message…>",
              "bb agentation toolbar [on|off]",
            ].join("\n"),
          );

        case "toolbar": {
          const desired = positional[0];
          if (desired === undefined) {
            return ok((await isToolbarEnabled()) ? "on" : "off");
          }
          if (desired !== "on" && desired !== "off") {
            return fail("usage: bb agentation toolbar [on|off]");
          }
          await bb.storage.kv.set(TOOLBAR_KEY, desired === "on");
          broadcast({ type: "config", sessionId: null });
          return ok(`toolbar ${desired}`);
        }

        case "pending": {
          const annotations = listAnnotations(db, {
            statuses: openStatuses,
            pluginId,
          });
          if (json) return ok(JSON.stringify(annotations, null, 2));
          if (annotations.length === 0) return ok("No open annotations.");
          return ok(annotations.map(renderAnnotationLine).join("\n"));
        }

        case "staged": {
          const annotations = listStagedAnnotations(db);
          if (json) return ok(JSON.stringify(annotations, null, 2));
          if (annotations.length === 0) return ok("No staged annotations.");
          return ok(annotations.map(renderAnnotationLine).join("\n"));
        }

        case "send": {
          const threadId = positional[0];
          if (!threadId) {
            return fail("usage: bb agentation send <threadId> [annotationId…]");
          }
          const requestedIds = positional.slice(1);
          const annotationIds =
            requestedIds.length > 0
              ? requestedIds
              : listStagedAnnotations(db).map((annotation) => annotation.id);
          if (annotationIds.length === 0) return ok("No staged annotations.");

          const result = await sendStagedToThread(annotationIds, threadId);
          return result.outcome === "sent"
            ? ok(result.message)
            : fail(result.message);
        }

        case "restage": {
          const id = positional[0];
          if (!id) return fail("usage: bb agentation restage <annotationId>");
          const routing = restageStoredAnnotation(db, id);
          if (!routing) {
            return fail(`Annotation ${id} is not an assigned open annotation.`);
          }
          broadcast({ type: "routing", sessionId: null });
          return ok(`staged ${id}`);
        }

        case "sessions": {
          const sessions = listSessions(db, {});
          if (sessions.length === 0) return ok("No annotated pages yet.");
          return ok(
            sessions
              .map(
                (session) =>
                  `${session.id}  ${session.route.padEnd(40)} pending=${session.counts.pending} total=${session.counts.total}`,
              )
              .join("\n"),
          );
        }

        case "show": {
          const id = positional[0];
          if (!id) return fail("usage: bb agentation show <annotationId>");
          const annotation = getAnnotation(db, id);
          if (!annotation) return fail(`No annotation ${id}.`);
          return ok(renderAnnotation(annotation));
        }

        case "acknowledge":
        case "resolve":
        case "dismiss": {
          const id = positional[0];
          if (!id) return fail(`usage: bb agentation ${command} <annotationId>`);
          const note = positional.slice(1).join(" ") || null;
          if (command === "dismiss" && !note) {
            return fail("usage: bb agentation dismiss <annotationId> <reason…>");
          }
          const status: AnnotationStatus =
            command === "acknowledge"
              ? "acknowledged"
              : command === "resolve"
                ? "resolved"
                : "dismissed";
          const annotation = setAnnotationStatus(db, {
            annotationId: id,
            status,
            by: "agent",
            resolution: note,
          });
          if (!annotation) return fail(`No annotation ${id}.`);
          broadcast({ type: "annotations", sessionId: annotation.sessionId });
          return ok(`${status} ${id}`);
        }

        case "reply": {
          const id = positional[0];
          const message = positional.slice(1).join(" ");
          if (!id || !message) {
            return fail("usage: bb agentation reply <annotationId> <message…>");
          }
          const annotation = appendThreadMessage(db, id, {
            role: "agent",
            content: message,
          });
          if (!annotation) return fail(`No annotation ${id}.`);
          broadcast({ type: "annotations", sessionId: annotation.sessionId });
          return ok(`Replied on ${id}.`);
        }

        default:
          return fail(
            `Unknown command "${command}". Run \`bb agentation help\`.`,
          );
      }
    },
  });

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  bb.background.schedule("prune", "17 4 * * *", async () => {
    const values = await settings.get();
    const days = Number.parseInt(values.retentionDays, 10);
    const removed = pruneClosed(db, Number.isFinite(days) ? days : 7);
    if (removed > 0) bb.log.info(`pruned ${removed} closed annotations`);
  });

  settings.onChange(() => {
    broadcast({ type: "config", sessionId: null });
  });

  bb.onDispose(() => {
    disposed = true;
    for (const timer of heartbeats.values()) clearInterval(timer);
    heartbeats.clear();
    for (const controller of streams) {
      try {
        controller.close();
      } catch {
        // The client may already be gone; nothing to clean up.
      }
    }
    streams.clear();
    for (const wake of watchers) wake();
    watchers.clear();
  });

  bb.log.info(`ready — ${countByStatus(db).pending} pending annotations`);
}
