// The annotation toolbar, mounted over the whole bb app shell.
//
// `agentation` ships a React component that portals itself to document.body,
// so the only thing it needs is a React root somewhere in the page. A content
// script is the right host for that: slots come and go with the surface that
// mounts them, but the toolbar has to survive every route in bb — the sidebar,
// a thread, Settings, and any plugin's own panel — because the point is to
// annotate all of them.
//
// A content script has no host React context, so everything that would
// normally be a hook is done by hand here: rpc over fetch, change notification
// over server-sent events, and route tracking by watching `location`.

import { createElement, type FunctionComponent } from "react";
import { createRoot, type Root } from "react-dom/client";
// Imported by path, not by package name: the copy under vendor/ carries changes
// upstream does not ship (see vendor/README.md), and a path import is the only
// form both Bun and the npm install bb runs for a `git:` source resolve the same
// way.
import {
  Agentation,
  loadAnnotations,
  saveAnnotations,
  type AgentationProps,
  type Annotation,
} from "../vendor/agentation/dist/index.mjs";
import type {
  PluginContentScriptContext,
  PluginContentScriptDisposer,
} from "@get-bb/plugin-sdk/app";

import type { BbContext, StoredAnnotation } from "./afs.ts";
import { selectOrphans, withoutBundleSource } from "./annotation-hygiene.ts";
import { createRpcClient } from "./plugin-rpc.ts";
import {
  labelForRoute,
  panelPluginIdFromRoute,
  projectIdFromRoute,
  threadIdFromRoute,
} from "./route.ts";
import { seedAgentationThemeDefault } from "./theme.ts";
import {
  createCoalescingQueue,
  createKeyedRequestCache,
  createReconciledCursor,
  createSerialTaskQueue,
  deleteLocalAnnotation,
  isCurrentRouteRequest,
  recordPushAcknowledgement,
  recordSnapshotAcknowledgement,
  shouldRequeueOperation,
  stableAnnotationSignature,
  toolbarTextFieldIsBusy,
  upsertLocalAnnotation,
} from "./toolbar-sync.ts";
import type { rpcContract } from "../server.ts";

/** How often to re-read `location`; bb navigates without a full page load. */
const ROUTE_POLL_MS = 400;
/** Coalesce a burst of toolbar callbacks into one write. */
const FLUSH_DEBOUNCE_MS = 250;
/** Safety-net poll interval while the event stream is healthy. */
const IDLE_POLL_MS = 30_000;
/** Poll interval when the event stream is unavailable. */
const FALLBACK_POLL_MS = 4_000;
/** Delay before retrying a write that failed, so a down backend is not hammered. */
const RETRY_DELAY_MS = 4_000;

/** Per-route record of which annotation ids the server has already accepted. */
const SYNCED_KEY_PREFIX = "bb-agentation-synced-";

/** Fields this plugin adds on the server and the toolbar has no use for. */
const SERVER_ONLY_FIELDS = [
  "bb",
  "seq",
  "sessionId",
  "resolution",
  "createdAt",
  "updatedAt",
] as const;

/**
 * `Agentation` is declared with an optional props parameter, which makes
 * `createElement` infer `Props | undefined` and reject a props object. The
 * component itself is an ordinary function component.
 */
const Toolbar = Agentation as FunctionComponent<AgentationProps>;

type PageMeta = {
  url: string;
  route: string;
  title: string;
  threadId: string | null;
  projectId: string | null;
};

type QueuedUpsert = {
  annotation: Annotation;
  bb: BbContext;
  page: PageMeta;
  revision: number;
};

type QueuedDelete = {
  id: string;
  page: PageMeta;
  revision: number;
};

type FlushGroup = {
  page: PageMeta;
  upserts: QueuedUpsert[];
  deletes: QueuedDelete[];
};

function pageMeta(): PageMeta {
  const route = window.location.pathname;
  return {
    url: window.location.href,
    route,
    title: document.title || route,
    threadId: threadIdFromRoute(route),
    projectId: projectIdFromRoute(route),
  };
}

/**
 * Which bb surface an element belongs to.
 *
 * bb wraps every plugin-rendered subtree in `<div data-bb-plugin-root
 * data-bb-plugin="<id>">`, including portalled overlays, so the nearest such
 * ancestor is an exact answer to "whose code draws this?" — the difference
 * between feedback an agent can act on and a selector with no home.
 */
function surfaceFor(
  element: Element | null,
  route: string,
): { pluginId: string | null; surface: string | null } {
  if (!element) return { pluginId: null, surface: null };

  const owner = element.closest<HTMLElement>("[data-bb-plugin]");
  const pluginId = owner?.getAttribute("data-bb-plugin") ?? null;
  if (!pluginId) return { pluginId: null, surface: null };

  if (element.closest("[data-bb-portaled-overlay]")) {
    return { pluginId, surface: "overlay" };
  }
  if (panelPluginIdFromRoute(route) === pluginId) {
    return { pluginId, surface: "navPanel" };
  }
  return { pluginId, surface: "inline" };
}

/** Ignore clicks on the toolbar's own chrome when tracking the last target. */
function isToolbarChrome(element: Element | null): boolean {
  return Boolean(
    element?.closest(
      "[data-agentation-root], [data-agentation-toolbar], [data-bb-agentation-host]",
    ),
  );
}

/**
 * What the toolbar should have in localStorage, given the server's view.
 *
 * `timestamp` is load-bearing: the toolbar drops anything older than its
 * seven-day retention window when it reads storage back, so an annotation
 * written here with a stale timestamp silently never appears.
 */
function toLocalAnnotation(stored: StoredAnnotation): Annotation {
  const clean: Record<string, unknown> = { ...stored };
  for (const field of SERVER_ONLY_FIELDS) delete clean[field];
  return clean as unknown as Annotation;
}

/**
 * Which annotation ids the server has accepted for a route.
 *
 * Reconcile has to tell two indistinguishable cases apart: an annotation the
 * server has never seen (typed just before a reload, or stranded by a failed
 * push — it must be kept and re-sent) and one the server had and no longer has
 * (deleted from the panel — it must go). The server's current list cannot
 * answer that, because the id is absent in both. This ledger can, and it
 * survives a reload because it lives beside the toolbar's own storage.
 */
function loadSynced(route: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${SYNCED_KEY_PREFIX}${route}`);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function saveSynced(route: string, ids: Iterable<string>): void {
  try {
    localStorage.setItem(`${SYNCED_KEY_PREFIX}${route}`, JSON.stringify([...ids]));
  } catch {
    // Storage full or disabled. Losing the ledger costs a resurrected
    // annotation at worst, never a lost one.
  }
}

export async function mountAnnotationToolbar(
  context: PluginContentScriptContext,
): Promise<PluginContentScriptDisposer> {
  const rpc = createRpcClient<typeof rpcContract>(context.pluginId);

  // bb resolves system/custom themes before plugin content scripts mount.
  // Seed once; Agentation owns and persists every user change after this.
  seedAgentationThemeDefault(localStorage, document.documentElement.classList.contains("dark"));

  const host = document.createElement("div");
  host.setAttribute("data-bb-agentation-host", "");
  document.body.appendChild(host);
  const root: Root = createRoot(host);

  let disposed = false;
  let enabled = true;
  let meta = pageMeta();
  let routeRevision = 0;
  let sessionId: string | null = null;
  const cursor = createReconciledCursor();
  let mountKey = 0;
  let pendingWrites = 0;
  let streamHealthy = false;
  let reconcileDeferred = false;
  let lastTarget: Element | null = null;
  let localMutationRevision = 0;

  // Queued work carries the page it was made on. bb can navigate between a
  // toolbar callback and the debounced flush that follows it, and an annotation
  // must land in the session for the page it describes, not for whatever page
  // the user happens to be looking at when the write finally goes out.
  const upsertQueue = new Map<string, QueuedUpsert>();
  const deleteQueue = new Map<string, QueuedDelete>();
  // Unlike the live queues, this ledger retains revisions after extraction so
  // an older failed request cannot overwrite newer work already waiting in the
  // serialized mutation queue.
  const latestRevisionById = new Map<string, number>();
  const clearedThroughByRoute = new Map<string, number>();
  const sessionsByRoute = createKeyedRequestCache<string, string>();
  const mutationQueue = createSerialTaskQueue();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let routeTimer: ReturnType<typeof setInterval> | null = null;
  let stream: EventSource | null = null;

  function contextForNewAnnotation(): BbContext {
    const { pluginId, surface } = surfaceFor(lastTarget, meta.route);
    return {
      route: meta.route,
      pluginId,
      surface,
      threadId: meta.threadId,
      projectId: meta.projectId,
      routeLabel: labelForRoute(meta.route),
    };
  }

  function enqueueUpsert(annotation: Annotation): void {
    // Agentation has already updated its React state when this callback runs,
    // but its localStorage effect runs later. Mirror the authoritative local
    // delta now so a fast server echo cannot reconcile against the old row.
    saveAnnotations(
      meta.route,
      upsertLocalAnnotation(loadAnnotations<Annotation>(meta.route), annotation),
    );
    localMutationRevision += 1;
    latestRevisionById.set(annotation.id, localMutationRevision);
    upsertQueue.set(annotation.id, {
      annotation: withoutBundleSource(annotation),
      bb: contextForNewAnnotation(),
      page: meta,
      revision: localMutationRevision,
    });
    deleteQueue.delete(annotation.id);
    scheduleFlush();
  }

  function enqueueDelete(annotation: Annotation): void {
    // Agentation keeps the row for its 150 ms exit animation. Its callback is
    // nevertheless the user's committed delete, so persistence must reflect
    // that intent before any RPC response can trigger reconciliation.
    saveAnnotations(
      meta.route,
      deleteLocalAnnotation(loadAnnotations<Annotation>(meta.route), annotation.id),
    );
    localMutationRevision += 1;
    latestRevisionById.set(annotation.id, localMutationRevision);
    upsertQueue.delete(annotation.id);
    deleteQueue.set(annotation.id, {
      id: annotation.id,
      page: meta,
      revision: localMutationRevision,
    });
    scheduleFlush();
  }

  function scheduleFlush(delayMs = FLUSH_DEBOUNCE_MS): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
  }

  async function flush(): Promise<void> {
    if (disposed) return;
    if (upsertQueue.size === 0 && deleteQueue.size === 0) return;

    const byRoute = new Map<string, FlushGroup>();
    const bucket = (page: PageMeta): FlushGroup => {
      const existing = byRoute.get(page.route);
      if (existing) return existing;
      const created: FlushGroup = { page, upserts: [], deletes: [] };
      byRoute.set(page.route, created);
      return created;
    };

    for (const item of upsertQueue.values()) bucket(item.page).upserts.push(item);
    for (const item of deleteQueue.values()) bucket(item.page).deletes.push(item);
    upsertQueue.clear();
    deleteQueue.clear();

    await runMutation(async () => {
      for (const group of byRoute.values()) {
        const id = await sessionFor(group.page);
        if (!id) {
          requeue(group);
          scheduleFlush(RETRY_DELAY_MS);
          continue;
        }
        try {
          await rpc.call("pushAnnotations", {
            sessionId: id,
            upserts: group.upserts.map((item) => ({
              annotation: item.annotation,
              bb: item.bb,
            })),
            deletedIds: group.deletes.map((item) => item.id),
          });
          const synced = recordPushAcknowledgement(
            loadSynced(group.page.route),
            group.upserts.map((item) => item.annotation.id),
            group.deletes.map((item) => item.id),
          );
          // Keep successful deletes in the ledger until the next complete
          // server snapshot removes their stale local rows. Agentation waits
          // 150 ms for its exit animation before updating localStorage; a
          // fast delete response can therefore observe the old row. Dropping
          // the id here would misclassify that row as never-sent feedback and
          // immediately recreate the annotation.
          saveSynced(group.page.route, synced);
        } catch (error) {
          // Put the work back so the next flush retries it rather than
          // silently losing feedback the human already typed, and forget the
          // session: the most likely reason a push fails is that the server no
          // longer has it, and the retry should open a new one.
          requeue(group);
          sessionsByRoute.forget(group.page.route);
          if (group.page.route === meta.route) sessionId = null;
          // Without this the restored work waits for the user's next action,
          // and a non-empty queue also stops every reconcile — so the toolbar
          // would quietly stop showing agent decisions too.
          scheduleFlush(RETRY_DELAY_MS);
          report("Could not save annotation", error);
        }
      }
    });
  }

  async function runMutation(task: () => Promise<void>): Promise<void> {
    // Count queued work as busy too. Otherwise a reconcile could run between
    // Clear and the serialized RPC that makes that local state authoritative.
    pendingWrites += 1;
    try {
      await mutationQueue.run(task);
    } catch (error) {
      report("Could not complete an annotation mutation", error);
    } finally {
      pendingWrites -= 1;
      // Mutation cursors can include unrelated agent decisions. Pull a full
      // snapshot only after the final queued mutation reaches the server.
      if (pendingWrites === 0) void pullQueue.request();
    }
  }

  function requeue(group: FlushGroup): void {
    const clearedThrough = clearedThroughByRoute.get(group.page.route) ?? 0;

    for (const item of group.upserts) {
      const id = item.annotation.id;
      if (
        !shouldRequeueOperation(item.revision, clearedThrough, latestRevisionById.get(id) ?? null)
      ) {
        continue;
      }
      upsertQueue.set(id, item);
      deleteQueue.delete(id);
    }
    for (const item of group.deletes) {
      if (
        !shouldRequeueOperation(
          item.revision,
          clearedThrough,
          latestRevisionById.get(item.id) ?? null,
        )
      ) {
        continue;
      }
      deleteQueue.set(item.id, item);
      upsertQueue.delete(item.id);
    }
  }

  /** The session for one page, opened once and reused. */
  async function sessionFor(
    page: PageMeta,
    activationRevision: number | null = null,
  ): Promise<string | null> {
    if (disposed) return null;
    const known = sessionsByRoute.get(page.route);
    if (known) {
      if (
        activationRevision !== null &&
        isCurrentRouteRequest(page.route, activationRevision, meta.route, routeRevision)
      ) {
        sessionId = known;
      }
      return known;
    }

    try {
      let openedAnnotations: StoredAnnotation[] | null = null;
      let openedCursor = 0;
      let openedToolbarEnabled = true;
      const id = await sessionsByRoute.getOrCreate(page.route, async () => {
        const result = await rpc.call("openSession", {
          url: page.url,
          route: page.route,
          title: page.title,
          threadId: page.threadId,
          projectId: page.projectId,
        });
        openedAnnotations = result.annotations;
        openedCursor = result.cursor;
        openedToolbarEnabled = result.config.toolbarEnabled;
        return result.session.id;
      });

      // Background writes may open a session, but only the activation that is
      // still current may change the toolbar. A route revision distinguishes
      // A -> B -> A from the original, now-obsolete A request.
      if (
        activationRevision !== null &&
        isCurrentRouteRequest(page.route, activationRevision, meta.route, routeRevision)
      ) {
        sessionId = id;
        if (openedAnnotations !== null) {
          applyConfig(openedToolbarEnabled);
          const outcome = reconcile(openedAnnotations, page.route);
          reconcileDeferred = outcome === "deferred";
          cursor.observe(openedCursor, !reconcileDeferred);
        } else {
          // This activation joined an open started by background work or an
          // obsolete activation, so its owner's snapshot is not ours to use.
          void pullQueue.request();
        }
      }
      return id;
    } catch (error) {
      report("Could not open an annotation session", error);
      return null;
    }
  }

  async function ensureSession(revision = routeRevision): Promise<string | null> {
    return sessionFor(meta, revision);
  }

  /**
   * Whether the toolbar holds work a remount would destroy.
   *
   * The annotation popup keeps typed text in component state, so remounting
   * throws it away — and a remount is most likely during watch mode, exactly
   * when an agent resolves other annotations while the user writes the next
   * one. The toolbar keeps a textarea mounted even with no popup open, so the
   * presence of one says nothing; what matters is whether it currently holds a
   * draft or the caret. An empty, unfocused field has nothing to lose.
   */
  function toolbarIsBusy(): boolean {
    const fields = document.querySelectorAll<HTMLTextAreaElement>(
      "[data-agentation-root] textarea",
    );
    for (const field of fields) {
      const rect = field.getBoundingClientRect();
      if (
        toolbarTextFieldIsBusy({
          value: field.value,
          focused: document.activeElement === field,
          width: rect.width,
          height: rect.height,
          settingsField: Boolean(field.closest("[data-agentation-settings-panel]")),
        })
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Make the browser agree with the server.
   *
   * The toolbar owns its own localStorage, so the only honest way to show it an
   * agent's decision is to write that storage and remount it — it re-reads on
   * mount and already drops resolved and dismissed items.
   *
   * Returns "deferred" when the browser is the fresher of the two, or is busy.
   * The caller must not advance its cursor on a deferred result, or the change
   * it just skipped would never be offered again.
   */
  function reconcile(
    annotations: StoredAnnotation[],
    route: string,
  ): "applied" | "in-sync" | "deferred" {
    if (disposed) return "deferred";
    // The route may have changed while the request was in flight; writing the
    // old page's annotations into the new page's storage would be worse than
    // waiting for the next poll.
    if (route !== meta.route) return "deferred";
    if (pendingWrites > 0 || upsertQueue.size > 0 || deleteQueue.size > 0) {
      return "deferred";
    }
    if (toolbarIsBusy()) return "deferred";

    const open = annotations.filter(
      (annotation) => annotation.status !== "resolved" && annotation.status !== "dismissed",
    );
    const local = loadAnnotations<Annotation>(route);

    // Anything local the server has never accepted is feedback in flight, not
    // feedback the agent resolved. Overwriting storage with the server's view
    // would destroy it — the queue guard above only protects it while this
    // page lives, and the common way to lose it is a reload seconds after
    // typing. Keep it, and make sure it is on its way.
    const knownToServer = new Set(annotations.map((item) => item.id));
    const synced = loadSynced(route);
    const orphans = selectOrphans(local, knownToServer, synced);
    for (const orphan of orphans) enqueueUpsert(orphan);

    const next = [...open.map(toLocalAnnotation), ...orphans];
    // A complete snapshot acknowledges remote-originated rows too. Without
    // this, another open bb window can receive an annotation, then recreate it
    // as an "unsent orphan" as soon as the originating window deletes it.
    // Missing ids are pruned only after `selectOrphans` consumed the previous
    // ledger as deletion tombstones above.
    saveSynced(route, recordSnapshotAcknowledgement(knownToServer));

    // The browser may retain an unusable bundle `sourceFile` that we
    // deliberately do not send to the server. Compare the same sanitized
    // shape on both sides so that this local-only detail does not remount and
    // collapse Agentation after an Add.
    if (
      stableAnnotationSignature(next.map(withoutBundleSource)) ===
      stableAnnotationSignature(local.map(withoutBundleSource))
    ) {
      return "in-sync";
    }

    saveAnnotations(route, next);
    render();
    return "applied";
  }

  function applyConfig(nextEnabled: boolean): void {
    if (nextEnabled === enabled) return;
    enabled = nextEnabled;
    render();
  }

  function report(message: string, error: unknown): void {
    // Content scripts have no toaster of their own and a failed annotation
    // write is not worth interrupting the user's thread for; the console is
    // where a plugin developer will look.
    console.warn(`[agentation] ${message}:`, error);
  }

  function render(): void {
    if (disposed) return;
    if (!enabled) {
      root.render(null);
      return;
    }

    mountKey += 1;
    root.render(
      createElement(Toolbar, {
        key: `${meta.route}#${mountKey}`,
        className: "bb-agentation-toolbar",
        onAnnotationAdd: enqueueUpsert,
        onAnnotationUpdate: enqueueUpsert,
        onAnnotationDelete: enqueueDelete,
        onAnnotationsClear: () => {
          // Upstream delays storage cleanup for its staggered clear animation.
          // The callback is the committed local action, so publish the empty
          // projection immediately and let its internal animation continue.
          saveAnnotations(meta.route, []);
          void clearOnServer();
        },
      }),
    );
  }

  async function clearOnServer(): Promise<void> {
    const page = meta;
    const activationRevision = routeRevision;
    localMutationRevision += 1;
    const clearRevision = localMutationRevision;
    clearedThroughByRoute.set(page.route, clearRevision);
    // "Clear all" is scoped to the page the toolbar is showing, so only that
    // page's queued work is abandoned.
    for (const [id, item] of upsertQueue) {
      if (item.page.route === page.route) upsertQueue.delete(id);
    }
    for (const [id, item] of deleteQueue) {
      if (item.page.route === page.route) deleteQueue.delete(id);
    }
    let clearSucceeded = false;
    await runMutation(async () => {
      // Resolve the session after older queued writes. A failed older push may
      // have invalidated the id that was current when Clear was clicked.
      const id = await sessionFor(page);
      if (!id) return;
      try {
        await rpc.call("clearSessionAnnotations", {
          sessionId: id,
        });
        saveSynced(page.route, []);
        clearSucceeded = true;
      } catch (error) {
        report("Could not clear annotations", error);
      }
    });
    if (
      !clearSucceeded &&
      isCurrentRouteRequest(page.route, activationRevision, meta.route, routeRevision)
    ) {
      // Agentation cleared its local state before calling us. The server did
      // not change, so an ordinary pull at the old cursor would say unchanged
      // and leave a false zero. Reset this active route's read cursor to force
      // the authoritative server snapshot back into local storage.
      cursor.reset();
      void pullQueue.request();
    }
  }

  async function pull(): Promise<void> {
    if (disposed) return;
    if (document.hidden) return;
    if (!sessionId) {
      // The session could not be opened at mount, or a failed push dropped it.
      // The poll chain is the only thing still running at that point, so it has
      // to be what recovers — otherwise the toolbar stays mounted and inert for
      // the rest of the page's life, showing no agent decisions at all.
      await ensureSession();
      if (disposed || document.hidden || !sessionId) return;
    }
    const route = meta.route;
    const activeSessionId = sessionId;
    try {
      const result = await rpc.call("pullSession", {
        sessionId: activeSessionId,
        cursor: cursor.value(),
      });
      applyConfig(result.config.toolbarEnabled);
      if (route !== meta.route || activeSessionId !== sessionId) return;
      if (!result.changed) {
        reconcileDeferred = false;
        return;
      }
      if (!cursor.hasNewer(result.cursor)) return;
      // Hold the cursor back when the change could not be applied, so the next
      // poll offers it again instead of reporting "nothing new".
      const outcome = reconcile(result.annotations, route);
      reconcileDeferred = outcome === "deferred";
      cursor.observe(result.cursor, !reconcileDeferred);
    } catch (error) {
      report("Could not refresh annotations", error);
    }
  }

  const pullQueue = createCoalescingQueue(pull, schedulePoll);

  function schedulePoll(): void {
    if (disposed) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    // A held-back change has no second event coming — the stream already fired
    // for it — so keep checking often until it can be applied.
    const delay =
      streamHealthy && !reconcileDeferred && sessionId !== null ? IDLE_POLL_MS : FALLBACK_POLL_MS;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pullQueue.request();
    }, delay);
  }

  function connectStream(): void {
    if (disposed) return;
    try {
      stream = new EventSource(
        `/api/v1/plugins/${encodeURIComponent(context.pluginId)}/http/events`,
      );
    } catch (error) {
      report("Event stream unavailable, falling back to polling", error);
      return;
    }

    stream.addEventListener("hello", () => {
      streamHealthy = true;
      void pullQueue.request();
    });
    stream.addEventListener("change", () => {
      streamHealthy = true;
      void pullQueue.request();
    });
    stream.addEventListener("error", () => {
      // EventSource reconnects on its own; the poll interval tightens until it
      // does, so a rejected or blocked stream degrades instead of going quiet.
      streamHealthy = false;
      schedulePoll();
    });
  }

  function onPointerDown(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (isToolbarChrome(target)) return;
    lastTarget = target;
  }

  function watchRoute(): void {
    routeTimer = setInterval(() => {
      if (disposed) return;
      if (window.location.pathname === meta.route) return;
      void switchRoute();
    }, ROUTE_POLL_MS);
  }

  async function switchRoute(): Promise<void> {
    // Adopt the new page synchronously, before any await: the route watcher
    // compares against `meta`, and a slow session round trip would otherwise
    // let the next tick start a second switch for the same navigation.
    const page = pageMeta();
    const revision = routeRevision + 1;
    routeRevision = revision;
    meta = page;
    sessionId = null;
    cursor.reset();
    reconcileDeferred = false;
    lastTarget = null;
    render();
    // Queued work carries the page it belongs to, so it does not have to be
    // drained before the switch — it will still reach the right session.
    void flush();
    const id = await sessionFor(page, revision);
    if (!id || !isCurrentRouteRequest(page.route, revision, meta.route, routeRevision)) {
      return;
    }
    // A cached session has no fresh snapshot attached. Pull now instead of
    // leaving a revisited route stale until the safety-net timer fires.
    await pullQueue.request();
  }

  document.addEventListener("pointerdown", onPointerDown, {
    capture: true,
    signal: context.signal,
  });
  document.addEventListener(
    "visibilitychange",
    () => {
      if (!document.hidden) void pullQueue.request();
    },
    { signal: context.signal },
  );

  render();
  await ensureSession();
  connectStream();
  schedulePoll();
  watchRoute();

  return () => {
    disposed = true;
    if (flushTimer !== null) clearTimeout(flushTimer);
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (routeTimer !== null) clearInterval(routeTimer);
    stream?.close();
    stream = null;
    // React refuses to unmount synchronously from inside a render pass; the
    // disposer never runs in one, but the microtask keeps that guarantee even
    // if the host ever changes when it disposes.
    queueMicrotask(() => {
      root.unmount();
      host.remove();
    });
  };
}
