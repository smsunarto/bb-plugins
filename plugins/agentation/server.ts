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

import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
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
  annotationMentionItemId,
  annotationMatchesMentionQuery,
  annotationMentionLabel,
  annotationSourceLabel,
  parseAnnotationMentionItemId,
  threadDisplayTitle,
} from "./lib/staging-display.ts";
import {
  renderAnnotation,
  renderAnnotationAssignment,
  renderAnnotationLine,
  renderAnnotationMentionContext,
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
  advanceTurnAssignments,
  claimStagedAnnotations,
  completeDispatch,
  discardStagedAnnotations,
  failDispatch,
  getAnnotationRouting,
  listAnnotationRoutings,
  listStagedAnnotations,
  recoverInterruptedDispatches,
  recoverInterruptedTurnAssignments,
  restageAnnotation as restageStoredAnnotation,
  restageTurnAssignments,
} from "./lib/staging.ts";
import {
  annotationDeliveryModes,
  followsBbDeliveryDefault,
  threadSendMode,
  turnAssignmentPhase,
} from "./lib/delivery.ts";
import { readInstructions } from "./lib/instructions.ts";

const openStatuses: AnnotationStatus[] = ["pending", "acknowledged"];

const configSchema = z.object({
  toolbarEnabled: z.boolean(),
});

export const rpcContract = defineRpcContract({
  // --- toolbar content script -------------------------------------------
  openSession: {
    experimental_description:
      "Open or reuse the annotation session for one bb page and return its annotations, cursor, and toolbar config.",
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
    experimental_description:
      "Upsert and delete annotations captured by the toolbar on one session.",
    input: z
      .object({
        sessionId: z.string(),
        upserts: z.array(z.object({ annotation: annotationSchema, bb: bbContextSchema })),
        deletedIds: z.array(z.string()),
      })
      .strict(),
    output: z.object({
      cursor: z.number().int(),
      annotations: z.array(storedAnnotationSchema),
    }),
  },
  pullSession: {
    experimental_description:
      "Return a session's annotations and config when the cursor moved past the caller's.",
    input: z.object({ sessionId: z.string(), cursor: z.number().int() }).strict(),
    output: z.object({
      cursor: z.number().int(),
      changed: z.boolean(),
      annotations: z.array(storedAnnotationSchema),
      config: configSchema,
    }),
  },
  clearSessionAnnotations: {
    experimental_description: "Delete every annotation on one session.",
    input: z.object({ sessionId: z.string() }).strict(),
    output: z.object({ cursor: z.number().int(), removed: z.number().int() }),
  },
  listStagedAnnotations: {
    experimental_description:
      "List annotations waiting for a thread, with the titles of threads they came from.",
    input: z.null(),
    output: z.object({
      annotations: z.array(storedAnnotationSchema),
      threadTitles: z.record(z.string(), z.string()),
    }),
  },
  discardStagedAnnotations: {
    experimental_description: "Dismiss staged annotations so they leave the composer banner.",
    input: z.object({ annotationIds: z.array(z.string()).min(1) }).strict(),
    output: z.object({
      outcome: z.enum(["discarded", "stale"]),
      discardedIds: z.array(z.string()),
      remainingCount: z.number().int(),
      message: z.string(),
    }),
  },
  sendStagedAnnotations: {
    experimental_description: "Assign staged annotations to a thread and send them as a message.",
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
    experimental_description: "Return an assigned annotation to staging.",
    input: z.object({ annotationId: z.string() }).strict(),
    output: z.object({ routing: annotationRoutingSchema.nullable() }),
  },

  // --- review panel ------------------------------------------------------
  getConfig: {
    experimental_description: "Read the toolbar config and annotation counts by status.",
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
    experimental_description: "Show or hide the annotation toolbar in every bb window.",
    input: z.object({ enabled: z.boolean() }).strict(),
    output: z.object({ toolbarEnabled: z.boolean() }),
  },
  listSessions: {
    experimental_description: "List annotated pages, optionally only active ones.",
    input: z.object({ status: z.enum(["active"]).nullable() }).strict(),
    output: z.object({ sessions: z.array(sessionSummarySchema) }),
  },
  listAnnotations: {
    experimental_description:
      "List annotations filtered by session, status, or owning plugin, with their thread routing.",
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
    experimental_description:
      "Acknowledge, resolve, dismiss, reopen, or delete one annotation as the human.",
    input: z
      .object({
        annotationId: z.string(),
        action: z.enum(["acknowledge", "resolve", "dismiss", "reopen", "delete"]),
        note: z.string().nullable(),
      })
      .strict(),
    output: z.object({
      annotation: storedAnnotationSchema.nullable(),
      deleted: z.boolean(),
    }),
  },
  replyToAnnotation: {
    experimental_description:
      "Post a human reply on an assigned annotation and forward it to its thread.",
    input: z.object({ annotationId: z.string(), message: z.string().min(1) }).strict(),
    output: z.object({ annotation: storedAnnotationSchema.nullable() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    deliveryMode: {
      type: "select",
      label: "When sending to an active thread",
      description:
        "Default follows bb's “Steer running threads on Enter” setting. Queue and Steer override it. Idle threads always start immediately.",
      options: [...annotationDeliveryModes],
      default: "Default",
    },
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
    bb.log.warn(`re-staged ${recoveredDispatches} annotations interrupted during delivery`);
  }
  const recoveredTurnAssignments = recoverInterruptedTurnAssignments(db);
  if (recoveredTurnAssignments > 0) {
    bb.log.warn(`re-staged ${recoveredTurnAssignments} annotations interrupted during a turn`);
  }

  bb.ui.registerMentionProvider({
    id: "annotation",
    label: "Annotations",
    async search({ query, threadId }) {
      const annotations = listAnnotations(db, { limit: null })
        .filter((annotation) => annotationMatchesMentionQuery(annotation, query))
        .slice(0, 25);
      const threadTitles = await resolveThreadTitles(annotations);

      return annotations.map((annotation) => ({
        id: annotationMentionItemId(annotation.id, threadId),
        title: annotationMentionLabel(
          annotation,
          annotationSourceLabel(annotation.bb, threadTitles),
        ),
        subtitle: `${annotation.element} · ${annotation.bb.routeLabel ?? annotation.bb.route}`,
        icon: "ChatFeedback",
      }));
    },
    async resolve(itemId) {
      const { annotationId, threadId } = parseAnnotationMentionItemId(itemId);
      const annotation = getAnnotation(db, annotationId);
      if (!annotation) throw new Error(`Annotation ${annotationId} no longer exists.`);
      if (threadId) await assignMentionToThread(annotationId, threadId);
      return {
        context: renderAnnotationMentionContext(annotation, getSession(db, annotation.sessionId)),
      };
    },
  });

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

    const frame = encoder.encode(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
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

  async function composerTurnPhase(
    threadId: string,
  ): Promise<"awaiting-start" | "awaiting-finish"> {
    try {
      const [thread, config] = await Promise.all([
        bb.sdk.threads.get({ threadId }),
        bb.sdk.system.config(),
      ]);
      const mode = threadSendMode("Default", config.generalSettings.steerActiveThreadOnEnter);
      return turnAssignmentPhase(thread.status, mode);
    } catch (error) {
      bb.log.warn(
        `could not inspect ${threadId} before assigning an annotation mention: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "awaiting-finish";
    }
  }

  async function assignMentionToThread(annotationId: string, threadId: string): Promise<void> {
    const phase = await composerTurnPhase(threadId);
    const claim = claimStagedAnnotations(db, { annotationIds: [annotationId], threadId });
    if (claim.outcome === "stale") return;

    completeDispatch(db, claim.dispatch.id, { reappearAfterTurn: phase });
    broadcast({ type: "routing", sessionId: null });
    bb.log.info(`assigned mentioned annotation ${annotationId} to ${threadId}`);
  }

  function publishRestagedAfterTurn(threadId: string, includeAwaitingStart = false): void {
    const count = restageTurnAssignments(db, threadId, { includeAwaitingStart });
    if (count === 0) return;
    broadcast({ type: "routing", sessionId: null });
    bb.log.info(
      `re-staged ${count} unresolved annotation${count === 1 ? "" : "s"} after ${threadId} finished`,
    );
  }

  bb.events.on("thread.active", ({ thread }) => {
    advanceTurnAssignments(db, thread.id);
  });
  bb.events.on("thread.idle", ({ thread }) => {
    publishRestagedAfterTurn(thread.id);
  });
  bb.events.on("thread.failed", ({ thread }) => {
    publishRestagedAfterTurn(thread.id, true);
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    publishRestagedAfterTurn(thread.id, true);
  });

  function dropStream(controller: ReadableStreamDefaultController<Uint8Array>): void {
    const heartbeat = heartbeats.get(controller);
    if (heartbeat) clearInterval(heartbeat);
    heartbeats.delete(controller);
    streams.delete(controller);
  }

  bb.http.route("GET", "/events", () => {
    let self: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self = controller;
        streams.add(controller);
        controller.enqueue(
          encoder.encode(`event: hello\ndata: ${JSON.stringify({ cursor: currentSeq(db) })}\n\n`),
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

    return new Response(stream, {
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
      const values = await settings.get();
      const steerActiveThreadOnEnter = followsBbDeliveryDefault(values.deliveryMode)
        ? (await bb.sdk.system.config()).generalSettings.steerActiveThreadOnEnter
        : false;
      const thread = await bb.sdk.threads.get({ threadId });
      const mode = threadSendMode(values.deliveryMode, steerActiveThreadOnEnter);
      await bb.sdk.threads.send({
        threadId,
        mode,
        input: [{ type: "text", text: instruction, mentions: [] }],
      });

      completeDispatch(db, claim.dispatch.id, {
        reappearAfterTurn: turnAssignmentPhase(thread.status, mode),
      });
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

  async function resolveThreadTitles(
    annotations: readonly z.infer<typeof storedAnnotationSchema>[],
  ): Promise<Record<string, string>> {
    const threadIds = [
      ...new Set(
        annotations.flatMap((annotation) =>
          annotation.bb.threadId ? [annotation.bb.threadId] : [],
        ),
      ),
    ];

    const entries = await Promise.all(
      threadIds.map(async (threadId) => {
        try {
          const thread = await bb.sdk.threads.get({ threadId });
          return [threadId, threadDisplayTitle(thread)] as const;
        } catch {
          return null;
        }
      }),
    );

    return Object.fromEntries(entries.filter((entry) => entry !== null));
  }

  // -------------------------------------------------------------------------
  // rpc
  // -------------------------------------------------------------------------

  bb.rpc.register(
    rpcContract,
    {
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

      async listStagedAnnotations() {
        const annotations = listStagedAnnotations(db);
        return sanitizeJson({
          annotations,
          threadTitles: await resolveThreadTitles(annotations),
        });
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

        const discardedIds = result.annotations.map((annotation) => annotation.id);
        return {
          outcome: "discarded" as const,
          discardedIds,
          remainingCount,
          message: `Discarded ${discardedIds.length} annotation${discardedIds.length === 1 ? "" : "s"}.`,
        };
      },

      async sendStagedAnnotations(input) {
        return sanitizeJson(await sendStagedToThread(input.annotationIds, input.threadId));
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
          throw new Error("Stage and send this annotation to a thread before you reply.");
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
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Annotation store behind the Agentation toolbar, review panel, and composer banner.",
    },
  );

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
    presentation: {
      label: {
        pending: "Listing annotation sessions",
        completed: "Listed annotation sessions",
      },
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
    presentation: {
      label: {
        pending: "Reading annotation session",
        completed: "Read annotation session",
      },
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
      "Get the open (pending or acknowledged) annotations for one session, rendered with the bb route, owning plugin, SDK UI registration, and DOM selector for each.",
    presentation: {
      label: {
        pending: "Reading pending annotations",
        completed: "Read pending annotations",
      },
    },
    parameters: z.object({ sessionId: z.string() }),
    execute({ sessionId }) {
      const session = getSession(db, sessionId);
      return toolText(
        renderAnnotations(listAnnotations(db, { sessionId, statuses: openStatuses }), {
          title: `Open annotations in ${sessionId}`,
          sessions: session ? [session] : [],
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_get_all_pending",
    description:
      "Get every open annotation across all bb pages. Use this when the human refers to UI feedback but did not supply a self-contained Agentation annotation batch.",
    instructions: readInstructions("get-all-pending"),
    presentation: {
      label: {
        pending: "Reading all pending annotations",
        completed: "Read all pending annotations",
      },
    },
    parameters: z.object({
      pluginId: z.string().optional().describe("Only annotations on this plugin's UI surfaces."),
    }),
    execute({ pluginId }) {
      return toolText(
        renderAnnotations(listAnnotations(db, { statuses: openStatuses, pluginId }), {
          title: "Open bb UI feedback",
          sessions: listSessions(db, {}),
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "agentation_acknowledge",
    description: "Mark an annotation as acknowledged so the human can see you have picked it up.",
    presentation: {
      label: {
        pending: "Acknowledging annotation",
        completed: "Acknowledged annotation",
      },
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
    presentation: {
      label: {
        pending: "Resolving annotation",
        completed: "Resolved annotation",
      },
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
    presentation: {
      label: {
        pending: "Dismissing annotation",
        completed: "Dismissed annotation",
      },
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
    presentation: {
      label: {
        pending: "Replying to annotation",
        completed: "Replied to annotation",
      },
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
    presentation: {
      label: {
        pending: "Watching for new annotations",
        completed: "Collected new annotations",
      },
    },
    parameters: z.object({
      sessionId: z.string().optional().describe("Only watch one page's session."),
      batchWindowSeconds: z
        .number()
        .int()
        .min(0)
        .max(60)
        .optional()
        .describe("After the first new annotation, keep collecting for this long. Default 10."),
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

      const appeared = await waitForChange(timeoutMs, context.signal, () => fresh().length > 0);
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
    let resolveSleep!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      resolveSleep = resolve;
    });
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveSleep();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    return sleeping;
  }

  /** Resolve true as soon as `test()` passes, false on timeout or abort. */
  function waitForChange(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    test: () => boolean,
  ): Promise<boolean> {
    if (test()) return Promise.resolve(true);

    let resolveChange!: (changed: boolean) => void;
    const change = new Promise<boolean>((resolve) => {
      resolveChange = resolve;
    });
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watchers.delete(wake);
      signal?.removeEventListener("abort", onAbort);
      resolveChange(value);
    };
    const wake = () => {
      if (test()) finish(true);
    };
    const onAbort = () => finish(false);

    const timer = setTimeout(() => finish(false), timeoutMs);
    watchers.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (disposed) finish(false);
    return change;
  }

  bb.agents.contributeInstructions(() => {
    try {
      const pending = countByStatus(db).pending;
      if (pending === 0) return null;
      return readInstructions("pending-feedback").replace(/{{pending}}|{{plural}}/g, (key) =>
        key === "{{pending}}" ? String(pending) : pending === 1 ? "" : "s",
      );
    } catch {
      return null;
    }
  });

  // -------------------------------------------------------------------------
  // CLI
  // -------------------------------------------------------------------------

  const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
  const ANNOTATION_ID = {
    name: "annotationId",
    description: "Annotation id, as `bb agentation pending` prints it",
    required: true,
  } as const;

  const ok = (stdout: string) => ({ exitCode: 0, stdout });

  function noAnnotation(id: string): PluginCliError {
    return new PluginCliError(`No annotation ${id}.`, {
      code: "annotation_not_found",
      hint: "Run `bb agentation pending` for the open annotation ids.",
    });
  }

  function renderAnnotationList(
    annotations: ReturnType<typeof listAnnotations>,
    json: boolean,
    empty: string,
  ) {
    if (json) return ok(JSON.stringify(annotations, null, 2));
    if (annotations.length === 0) return ok(empty);
    return ok(annotations.map(renderAnnotationLine).join("\n"));
  }

  function closeAnnotation(id: string, status: AnnotationStatus, note: readonly string[]) {
    const annotation = setAnnotationStatus(db, {
      annotationId: id,
      status,
      by: "agent",
      resolution: note.join(" ") || null,
    });
    if (!annotation) throw noAnnotation(id);
    broadcast({ type: "annotations", sessionId: annotation.sessionId });
    return ok(`${status} ${id}`);
  }

  bb.cli.register(
    defineCli({
      name: "agentation",
      summary: "Read and resolve visual feedback left on the bb interface",
      commands: {
        pending: cliCommand({
          summary: "Show every open annotation",
          options: {
            plugin: {
              type: "string",
              placeholder: "id",
              description: "Only annotations left on this plugin's UI",
            },
            json: JSON_OPTION,
          },
          run(input) {
            return renderAnnotationList(
              listAnnotations(db, { statuses: openStatuses, pluginId: input.options.plugin }),
              input.options.json,
              "No open annotations.",
            );
          },
        }),
        staged: cliCommand({
          summary: "Show annotations waiting for a thread",
          options: { json: JSON_OPTION },
          run(input) {
            return renderAnnotationList(
              listStagedAnnotations(db),
              input.options.json,
              "No staged annotations.",
            );
          },
        }),
        send: cliCommand({
          summary: "Assign staged annotations to a thread",
          positionals: [
            {
              name: "threadId",
              description: "Thread that receives the annotations",
              required: true,
            },
            {
              name: "annotationId",
              description: "Staged annotation ids; omit to send every staged annotation",
              variadic: true,
            },
          ],
          async run(input) {
            const requestedIds = input.positionals.annotationId;
            const annotationIds =
              requestedIds.length > 0
                ? requestedIds
                : listStagedAnnotations(db).map((annotation) => annotation.id);
            if (annotationIds.length === 0) return ok("No staged annotations.");

            const result = await sendStagedToThread(annotationIds, input.positionals.threadId);
            if (result.outcome === "stale") {
              throw new PluginCliError(result.message, { code: "stale_staging" });
            }
            return ok(result.message);
          },
        }),
        restage: cliCommand({
          summary: "Return an assigned annotation to staging",
          positionals: [ANNOTATION_ID],
          run(input) {
            const id = input.positionals.annotationId;
            if (!restageStoredAnnotation(db, id)) {
              throw new PluginCliError(`Annotation ${id} is not an assigned open annotation.`, {
                code: "not_assigned",
                hint: "Run `bb agentation pending` to see each annotation's state.",
              });
            }
            broadcast({ type: "routing", sessionId: null });
            return ok(`staged ${id}`);
          },
        }),
        sessions: cliCommand({
          summary: "List annotated pages",
          run() {
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
          },
        }),
        show: cliCommand({
          summary: "Show one annotation in full",
          positionals: [ANNOTATION_ID],
          run(input) {
            const annotation = getAnnotation(db, input.positionals.annotationId);
            if (!annotation) throw noAnnotation(input.positionals.annotationId);
            return ok(renderAnnotation(annotation));
          },
        }),
        acknowledge: cliCommand({
          summary: "Mark an annotation as seen",
          positionals: [
            ANNOTATION_ID,
            {
              name: "note",
              description: "Optional note stored with the annotation",
              variadic: true,
            },
          ],
          run(input) {
            return closeAnnotation(
              input.positionals.annotationId,
              "acknowledged",
              input.positionals.note,
            );
          },
        }),
        resolve: cliCommand({
          summary: "Mark an annotation as fixed",
          positionals: [
            ANNOTATION_ID,
            { name: "summary", description: "What changed, shown to the human", variadic: true },
          ],
          run(input) {
            return closeAnnotation(
              input.positionals.annotationId,
              "resolved",
              input.positionals.summary,
            );
          },
        }),
        dismiss: cliCommand({
          summary: "Decline an annotation, with a reason",
          positionals: [
            ANNOTATION_ID,
            { name: "reason", description: "Why the annotation is declined", variadic: true },
          ],
          run(input) {
            if (input.positionals.reason.length === 0) {
              throw new PluginCliError("dismiss needs a reason", {
                code: "missing_required",
                hint: "usage: bb agentation dismiss <annotationId> <reason…>",
              });
            }
            return closeAnnotation(
              input.positionals.annotationId,
              "dismissed",
              input.positionals.reason,
            );
          },
        }),
        reply: cliCommand({
          summary: "Ask the human a question on an annotation",
          positionals: [
            ANNOTATION_ID,
            { name: "message", description: "Question or note for the human", variadic: true },
          ],
          run(input) {
            const id = input.positionals.annotationId;
            const message = input.positionals.message.join(" ");
            if (!message) {
              throw new PluginCliError("reply needs a message", {
                code: "missing_required",
                hint: "usage: bb agentation reply <annotationId> <message…>",
              });
            }
            const annotation = appendThreadMessage(db, id, { role: "agent", content: message });
            if (!annotation) throw noAnnotation(id);
            broadcast({ type: "annotations", sessionId: annotation.sessionId });
            return ok(`Replied on ${id}.`);
          },
        }),
        toolbar: cliCommand({
          summary: "Show or set whether the annotation toolbar is displayed",
          positionals: [
            { name: "state", description: "on or off; omit it to print the current state" },
          ],
          async run(input) {
            const desired = input.positionals.state;
            if (desired === undefined) return ok((await isToolbarEnabled()) ? "on" : "off");
            if (desired !== "on" && desired !== "off") {
              throw new PluginCliError(`toolbar state must be on or off, got "${desired}"`, {
                code: "invalid_value",
                hint: "usage: bb agentation toolbar [on|off]",
              });
            }
            await bb.storage.kv.set(TOOLBAR_KEY, desired === "on");
            broadcast({ type: "config", sessionId: null });
            return ok(`toolbar ${desired}`);
          },
        }),
      },
    }),
  );

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
