import {
  type ReviewCanvasContent,
  resolveReviewSourceView,
} from "../../shared/review-protocol/index.ts";
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";

import type { ActivitySnapshot } from "../../server/lib/review/activity.ts";
import type { LiveSnapshot } from "../../server/lib/review/store.ts";
import { followLive, isTerminalRefusal, useLiveRead } from "../live.ts";
import { useWhiteboardRpc } from "../rpc.ts";
import { ApiDocument, type ApiDocumentData, createDocumentLoader } from "./api-document.tsx";
import { retainedTrace } from "./api-trace.ts";
import { App } from "./App.tsx";
import type { RenderedReviewDocument } from "./App.tsx";
import { AuthoringActivityContext } from "./authoring-activity.tsx";
import { type AuthoringCursor, type CursorMemory, nextCursor } from "./authoring-cursor.ts";
import { DisplayedReviewVersionContext } from "./displayed-review-version-context.ts";
import { DrawQueueProvider } from "./draw-queue-provider.tsx";
import {
  ReviewSessionProvider,
  createReviewSession,
  useReviewSession,
} from "./host/review-session.tsx";
import { ReviewDocumentBoundary } from "./review-document-boundary.tsx";
import { reportReviewDocumentRenderError } from "./review-document-error-report.ts";
import type { ReviewFindHost } from "./review-find.tsx";
import { ReviewLensesProvider } from "./review-lenses.tsx";
import type { NormalizedSoftwareModel } from "./software-map/model.ts";
import { TutorialProvider } from "./tutorial-context.tsx";

type ApiContent = Extract<ReviewCanvasContent, { kind: "api" }>;

const DocumentData = createContext<ApiDocumentData | null>(null);

const MapEnabled = createContext(false);

// A stable component type keeps sections, diagram tours and selections mounted.
function DocumentBody() {
  const data = useContext(DocumentData)!;
  const session = useReviewSession();
  const softwareMapEnabled = useContext(MapEnabled);

  // App keys its boundary on the review id; this one recovers on the next version.
  return (
    <ReviewDocumentBoundary
      revision={`${data.snapshot.reviewId}:${data.snapshot.version}:${data.snapshot.source?.pins.worktreeRevision ?? ""}`}
      onError={(_revision, error) => reportReviewDocumentRenderError(session, error)}
    >
      <ApiDocument data={data} softwareMapEnabled={softwareMapEnabled} />
    </ReviewDocumentBoundary>
  );
}

/** New pins or diff mode hand native views fresh factories, so DiffView and
 * DocumentCodeView recreate them. */
function useNativeSources(
  bridge: ApiContent["bridge"],
  sourceKey: string | undefined,
  structuralDiffEnabled: boolean | undefined,
) {
  const copy = () => ({
    bridge,
    sourceKey,
    structuralDiffEnabled,
    sources: { inlineEditors: { ...bridge.inlineEditors }, diffView: { ...bridge.diffView } },
  });
  const [native, setNative] = useState(copy);

  if (
    native.bridge !== bridge ||
    native.sourceKey !== sourceKey ||
    native.structuralDiffEnabled !== structuralDiffEnabled
  ) {
    setNative(copy());
  }

  return native.sources;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function CanvasError({ message }: { message: string }) {
  // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a status message, not a form result, which is what <output> means
  return <p role="status">{message}</p>;
}

export function ApiCanvas({
  content,
  threadId,
  findHost,
}: {
  content: ApiContent;
  /** The panel's thread; absent on the Home navPanel. */
  threadId?: string;
  findHost?: ReviewFindHost;
}) {
  const rpc = useWhiteboardRpc(threadId);
  const live = useLiveRead("liveSession", { threadId, sessionId: content.reviewId });

  const [version, setVersion] = useState(content.version);
  // A new version from the panel replaces the one on screen.
  const [panelVersion, setPanelVersion] = useState(content.version);
  if (panelVersion !== content.version) {
    setPanelVersion(content.version);
    setVersion(content.version);
  }

  const [coverageRevision, setCoverageRevision] = useState(0);
  const [activity, setActivity] = useState<ActivitySnapshot | "unknown">();
  const [cursor, setCursor] = useState<AuthoringCursor | null>(null);
  const [lensCursor, setLensCursor] = useState<AuthoringCursor | null>(null);
  const [data, setData] = useState<ApiDocumentData>();
  // The pins and version the document was read at (see useNativeSources).
  const [sourceKey, setSourceKey] = useState<string>();
  const [error, setError] = useState<string>();
  // The panel's callbacks are not reactive: a new callback must not reload the document.
  const publishShown = useEffectEvent((snapshot: LiveSnapshot, shown: number | undefined) => {
    content.setSourceView?.(
      shown === undefined
        ? { reviewId: snapshot.reviewId, kind: "current" }
        : { reviewId: snapshot.reviewId, kind: "version", version: shown },
      resolveReviewSourceView(snapshot),
    );
    content.setTitle?.(snapshot.title);
  });
  useEffect(() => {
    const abort = new AbortController();
    const loader = createDocumentLoader(rpc);
    // oxlint-disable-next-line react/set-state-in-effect -- a new source or version blanks the old document until this effect's load answers
    setData(undefined);
    setActivity(undefined);
    setCursor(null);
    setLensCursor(null);
    // One stream, two couriers: each scope folds its own edits and focus.
    const cursorMemory: CursorMemory = {};
    const lensMemory: CursorMemory = {};

    // Each load's place in delivery order: a slower older load never replaces a newer one.
    let latestLoad = 0;
    const show = async (snapshot: LiveSnapshot) => {
      const load = ++latestLoad;
      const next = await loader.load(
        snapshot,
        version === undefined ? snapshot.source?.pins.worktreeRevision : undefined,
      );

      if (abort.signal.aborted || load !== latestLoad) return;

      // Native source widgets must use these pins on their first mount.
      const key = JSON.stringify([
        snapshot.reviewId,
        snapshot.source?.pins,
        version === undefined ? "current" : version,
      ]);

      setSourceKey(key);
      publishShown(snapshot, version);
      setData(next);
      setError(undefined);
    };

    void (async () => {
      if (version !== undefined) {
        try {
          const snapshot = await rpc.sessionVersion({ sessionId: content.reviewId, version });
          if (abort.signal.aborted) return;
          await show(snapshot);
        } catch (cause) {
          if (!abort.signal.aborted) setError(message(cause));
        }
      }

      // The live read answers the same version again whenever activity moves;
      // the document reloads only when what it reads from changed.
      const shownKey = (snapshot: LiveSnapshot) =>
        JSON.stringify([snapshot.version, snapshot.source?.pins.worktreeRevision, snapshot.live]);
      let shownVersion: string | undefined;
      followLive(
        live,
        abort.signal,
        async (snapshot) => {
          setActivity(snapshot.activity);
          setCursor((current) => nextCursor(current, cursorMemory, snapshot));
          setLensCursor((current) => nextCursor(current, lensMemory, snapshot, "lenses"));
          setCoverageRevision(snapshot.coverageRevision);

          if (version !== undefined) return;

          if (shownVersion === shownKey(snapshot)) {
            setError(undefined);

            return;
          }

          try {
            await show(snapshot);
            shownVersion = shownKey(snapshot);
          } catch (cause) {
            // A failed resource or source read is a document problem. The
            // live read and the activity signal are still healthy, so do not
            // report unknown activity.
            if (!abort.signal.aborted) setError(message(cause));
          }
        },
        (cause) => {
          setActivity("unknown");
          setCursor((current) =>
            current
              ? nextCursor(current, cursorMemory, {
                  version: cursorMemory.version ?? 0,
                  activity: "unknown",
                })
              : current,
          );

          setLensCursor((current) =>
            current
              ? nextCursor(
                  current,
                  lensMemory,
                  {
                    version: lensMemory.version ?? 0,
                    activity: "unknown",
                  },
                  "lenses",
                )
              : current,
          );

          if (isTerminalRefusal(cause)) {
            setError(cause.message);

            return;
          }

          setError(`Connection lost. Reconnecting… ${cause instanceof Error ? cause.message : ""}`);
        },
      );
    })();

    return () => {
      abort.abort();
      loader.dispose();
    };
  }, [rpc, live, content.reviewId, version]);

  const nativeSources = useNativeSources(content.bridge, sourceKey, content.structuralDiffEnabled);

  const baseSession = useMemo(() => {
    const bridge = {
      ...content.bridge,
      ...nativeSources,
      post: async (request: Parameters<ApiContent["bridge"]["post"]>[0]) => {
        if (request.name === "openReviewRevision") {
          setVersion(
            request.args.revision === undefined ? undefined : Number(request.args.revision),
          );

          return { ok: true as const };
        }

        return content.bridge.post(request);
      },
    };

    const session = createReviewSession(bridge, {
      rpc,
      sessionId: content.reviewId,
      version: () => undefined,
    });

    session.softwareMapData = () => undefined;

    return session;
  }, [content.bridge, content.reviewId, nativeSources, rpc]);

  const session = useMemo(() => {
    if (!data) return baseSession;
    const snapshot = data.snapshot;

    return {
      ...baseSession,
      version: () => snapshot.version,
      softwareMapData: (model: NormalizedSoftwareModel) =>
        [...data.maps.values()].find((map) => map === model)?.pinnedData,
      review: {
        kind: snapshot.kind,
        pins: snapshot.source
          ? { base: snapshot.source.pins.base, head: snapshot.source.pins.head }
          : undefined,
        historicalRevision: version === undefined ? null : String(version),
        updatedAtMs: Date.parse(snapshot.createdAt),
        headBranch: snapshot.origin?.branch,
        pullRequestNumber: snapshot.origin?.pullRequestNumber,
        pullRequestUrl: snapshot.origin?.pullRequestUrl,
        traces: new Map([...data.traces].map(([id, trace]) => [id, retainedTrace(id, trace)])),
        listVersions: async () => {
          const history = await rpc.history({ sessionId: content.reviewId });

          return history.map((item) => ({
            revision: String(item.version),
            sealedAt: Date.parse(item.createdAt),
            isCurrent: item.version === snapshot.version,
          }));
        },
        stack: async () =>
          (await rpc.stack({ sessionId: snapshot.reviewId, version: snapshot.version })).layers,
        dismiss: async () => {
          await rpc.command({
            commandId: crypto.randomUUID(),
            operation: {
              type: "attention",
              reviewId: content.reviewId,
              action: "dismiss",
            },
          });
        },
      },
    };
  }, [baseSession, rpc, content.reviewId, data, version]);

  const hasData = data !== undefined;
  useEffect(() => {
    if (hasData) content.bridge.ready();
  }, [hasData, content.bridge]);

  const tutorialOrigin = data?.snapshot.origin?.tutorial;
  const publishTutorial = useEffectEvent(() => {
    if (data) content.setTutorial?.(data.snapshot.origin?.tutorial === true);
  });
  // Reports when the tutorial flag or the callback changes, not on every reload.
  useEffect(() => {
    publishTutorial();
  }, [tutorialOrigin, content.setTutorial]);

  // Loads are near-instant, so stay blank until there is data or an error.
  if (!data)
    return (
      error !== undefined && (
        <>
          <CanvasError message={error} />
          {version !== undefined && (
            <button onClick={() => setVersion(undefined)}>Back to latest version</button>
          )}
        </>
      )
    );

  return (
    <ReviewSessionProvider session={session}>
      <DocumentData.Provider value={data}>
        <ReviewLensesProvider
          rpc={rpc}
          snapshot={data.snapshot}
          coverageRevision={coverageRevision}
          sourceGeneration={
            version === undefined ? data.snapshot.source?.pins.worktreeRevision : undefined
          }
          structuralDiffEnabled={content.structuralDiffEnabled}
        >
          <TutorialProvider tutorial={content.tutorial}>
            {error && <CanvasError message={error} />}
            <AuthoringActivityContext.Provider value={version === undefined ? activity : undefined}>
              <DrawQueueProvider cursor={version === undefined ? cursor : undefined}>
                <DrawQueueProvider
                  scope="lenses"
                  cursor={version === undefined ? lensCursor : undefined}
                >
                  <DisplayedReviewVersionContext.Provider value={data.snapshot.version}>
                    <MapEnabled.Provider value={content.softwareMapEnabled === true}>
                      <CanvasDocument
                        data={data}
                        findHost={findHost}
                        softwareMapEnabled={content.softwareMapEnabled === true}
                      />
                    </MapEnabled.Provider>
                  </DisplayedReviewVersionContext.Provider>
                </DrawQueueProvider>
              </DrawQueueProvider>
            </AuthoringActivityContext.Provider>
          </TutorialProvider>
        </ReviewLensesProvider>
      </DocumentData.Provider>
    </ReviewSessionProvider>
  );
}

// Activity updates only the badge; keep diagram inputs stable until document data changes.
const CanvasDocument = memo(function CanvasDocument({
  data,
  findHost,
  softwareMapEnabled,
}: {
  data: ApiDocumentData;
  findHost?: ReviewFindHost;
  softwareMapEnabled: boolean;
}) {
  const snapshot = data.snapshot;

  const document: RenderedReviewDocument = {
    key: snapshot.reviewId,
    routePath: "/",
    filePath: `review:${snapshot.reviewId}`,
    documentSoftwareModels: [...data.maps.values()],
    anchors: data.anchors,
    render: DocumentBody,
    tocEntries: data.headings.entries,
    empty: snapshot.document.length === 0,
  };

  return (
    <App
      documentState={{ state: "ready", document }}
      softwareMapState={{
        state: "ready",
        softwareMap: {
          head: [...data.maps.values()].find((map) => map.pinnedData.side === "head") ?? null,
          base: [...data.maps.values()].find((map) => map.pinnedData.side === "base") ?? null,
        },
      }}
      softwareMapEnabled={softwareMapEnabled && data.maps.size > 0}
      // Worktree source enables Diff independently of an actual commit range.
      range={{
        live: snapshot.live,
        target: snapshot.source?.target,
        baseRef: snapshot.source?.pins.base ?? "",
        headRef: snapshot.source?.pins.head ?? "",
        baseCommit: snapshot.source?.pins.base ?? "",
        headCommit: snapshot.source?.pins.head ?? "",
      }}
      commits={data.commits}
      findHost={findHost}
    />
  );
});
