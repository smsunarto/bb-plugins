// bb-plugin-pr-walkthrough — frontend entry.
//
// Renders the compiled walkthrough natively inside bb:
// - `::pr-walkthrough{path="..."}` message directive the skill emits after a
//   successful build, rendered as an "Open walkthrough" affordance.
// - A thread panel tab that renders review groups, explanations, and diffs
//   with bb's own Pierre diff renderer — no static-site hosting involved.
import "./app.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  Markdown,
  useBbNavigate,
  useRpc,
  type PluginMessageDirectiveProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import { parsePatchFiles, type DiffLineAnnotation } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { toast } from "sonner";
import type {
  rpcContract,
  WalkthroughData,
  WalkthroughDiffFile,
  WalkthroughGuideBlock,
  WalkthroughGuideComment,
  WalkthroughGuideDiagram,
  WalkthroughGuideExcerpt,
  WalkthroughReviewGroup,
} from "./server";
import { Button } from "@/components/ui/button";
import { ChangedFileTree } from "@/components/walkthrough/changed-file-tree";

const VIEWER_ACTION_ID = "viewer";
const DEFAULT_TITLE = "PR walkthrough";

type DiffStyle = "unified" | "split";

function WalkthroughDirective({ attributes }: PluginMessageDirectiveProps) {
  const navigate = useBbNavigate();
  const title = attributes.title?.trim() || DEFAULT_TITLE;
  const path = attributes.path?.trim();

  return (
    <div className="my-2 flex items-center justify-between gap-3 rounded-md border border-border bg-card px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">
          {title}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          Semantic review guide built in this workspace
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          const opened = navigate.openThreadPanel({
            actionId: VIEWER_ACTION_ID,
            title,
            params: path ? { path } : null,
          });
          if (!opened) {
            toast.error("This surface has no thread side panel.");
          }
        }}
      >
        Open walkthrough
      </Button>
    </div>
  );
}

function GuideBlocks({ blocks }: { blocks: WalkthroughGuideBlock[] }) {
  return (
    <div className="space-y-2 text-sm text-foreground">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "paragraph":
            return <Markdown key={index} content={block.text} />;
          case "list":
            return (
              <Markdown
                key={index}
                content={block.items
                  .map((item, i) =>
                    block.ordered ? `${i + 1}. ${item}` : `- ${item}`,
                  )
                  .join("\n")}
              />
            );
          case "code":
            return (
              <Markdown
                key={index}
                content={`\`\`\`${block.language ?? ""}\n${block.code}\n\`\`\``}
              />
            );
          case "quote":
            return <Markdown key={index} content={`> ${block.text}`} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

function PatchDiff({
  patch,
  diffStyle,
  lineAnnotations,
}: {
  patch: string;
  diffStyle: DiffStyle;
  lineAnnotations?: DiffLineAnnotation<WalkthroughGuideComment>[];
}) {
  const fileDiff = useMemo(() => {
    try {
      return parsePatchFiles(patch)[0]?.files[0];
    } catch {
      return undefined;
    }
  }, [patch]);

  if (fileDiff === undefined) {
    return (
      <pre className="overflow-x-auto rounded-md border border-border bg-card p-3 text-xs">
        {patch}
      </pre>
    );
  }
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <FileDiff<WalkthroughGuideComment>
        fileDiff={fileDiff}
        lineAnnotations={lineAnnotations}
        options={{ diffStyle }}
        renderAnnotation={(annotation) =>
          annotation.metadata ? (
            <div className="border-y border-primary/20 bg-primary/5 px-3 py-2 text-xs text-foreground">
              <span className="mr-2 font-mono text-primary">
                {annotation.metadata.side === "additions" ? "R" : "L"}
                {annotation.metadata.lineNumber}
              </span>
              {annotation.metadata.body}
            </div>
          ) : null
        }
      />
    </div>
  );
}

function GuideDiagram({ diagram }: { diagram: WalkthroughGuideDiagram }) {
  const labels = new Map(diagram.nodes.map((node) => [node.id, node.label]));
  return (
    <figure
      aria-label={diagram.summary}
      className="space-y-3 rounded-md border border-border bg-card p-3"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {diagram.nodes.map((node) => (
          <div key={node.id} className="rounded-md border border-border p-2">
            <div className="text-xs font-medium text-foreground">
              {node.label}
            </div>
            {node.detail && (
              <div className="mt-1 text-xs text-muted-foreground">
                {node.detail}
              </div>
            )}
          </div>
        ))}
      </div>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {diagram.edges.map((edge) => (
          <li key={edge.id}>
            <span className="text-foreground">{labels.get(edge.source)}</span>
            {" → "}
            <span className="text-foreground">{labels.get(edge.target)}</span>
            {edge.label ? ` — ${edge.label}` : ""}
          </li>
        ))}
      </ul>
      <figcaption className="text-xs text-muted-foreground">
        {diagram.summary}
      </figcaption>
    </figure>
  );
}

function ExcerptSection({
  excerpt,
  diffStyle,
  reviewed,
  onToggleReviewed,
}: {
  excerpt: WalkthroughGuideExcerpt;
  diffStyle: DiffStyle;
  reviewed: boolean;
  onToggleReviewed: () => void;
}) {
  const lineAnnotations = useMemo<
    DiffLineAnnotation<WalkthroughGuideComment>[]
  >(
    () =>
      excerpt.comments.map((comment) => ({
        lineNumber: comment.lineNumber,
        metadata: comment,
        side: comment.side,
      })),
    [excerpt.comments],
  );

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-medium text-foreground">{excerpt.title}</h4>
        <Button
          aria-pressed={reviewed}
          size="sm"
          variant={reviewed ? "secondary" : "outline"}
          onClick={onToggleReviewed}
        >
          {reviewed ? "Viewed" : "Mark viewed"}
        </Button>
      </div>
      <GuideBlocks blocks={excerpt.explanation} />
      {excerpt.binary ? (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          Binary file: {excerpt.path}
        </div>
      ) : (
        <PatchDiff
          patch={excerpt.patch}
          diffStyle={diffStyle}
          lineAnnotations={lineAnnotations}
        />
      )}
    </section>
  );
}

function NormalMode({
  group,
  diffFiles,
  diffStyle,
  reviewedPaths,
  onToggleReviewed,
}: {
  group: WalkthroughReviewGroup;
  diffFiles: WalkthroughDiffFile[];
  diffStyle: DiffStyle;
  reviewedPaths: Set<string>;
  onToggleReviewed: (path: string) => void;
}) {
  const [showGenerated, setShowGenerated] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | undefined>();
  const sectionRefs = useRef(new Map<string, HTMLElement>());

  const byPath = useMemo(
    () => new Map(diffFiles.map((file) => [file.path, file])),
    [diffFiles],
  );
  const files = group.files
    .map((file) => ({ file, diff: byPath.get(file.path) }))
    .filter((entry) => entry.diff !== undefined);
  const primary = files.filter(
    (entry) => !entry.diff!.generated && !entry.diff!.binary,
  );
  const generated = files.filter(
    (entry) => entry.diff!.generated || entry.diff!.binary,
  );
  const treeFiles = useMemo(
    () =>
      files
        .filter(
          (entry) =>
            showGenerated || (!entry.diff!.generated && !entry.diff!.binary),
        )
        .map((entry) => entry.diff!),
    [files, showGenerated],
  );

  const selectPath = (path: string) => {
    setSelectedPath(path);
    sectionRefs.current
      .get(path)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const renderEntry = (entry: (typeof files)[number]) => (
    <section
      key={entry.file.path}
      ref={(element) => {
        if (element === null) sectionRefs.current.delete(entry.file.path);
        else sectionRefs.current.set(entry.file.path, element);
      }}
      className="scroll-mt-2 space-y-2"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs text-foreground">
            {entry.file.path}
          </div>
          {entry.file.note && (
            <p className="mt-1 text-sm text-muted-foreground">
              {entry.file.note}
            </p>
          )}
        </div>
        <Button
          aria-pressed={reviewedPaths.has(entry.file.path)}
          size="sm"
          variant={
            reviewedPaths.has(entry.file.path) ? "secondary" : "outline"
          }
          onClick={() => onToggleReviewed(entry.file.path)}
        >
          {reviewedPaths.has(entry.file.path) ? "Viewed" : "Mark viewed"}
        </Button>
      </div>
      {entry.diff!.binary ? (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          Binary file: {entry.diff!.path}
        </div>
      ) : (
        <PatchDiff patch={entry.diff!.patch} diffStyle={diffStyle} />
      )}
    </section>
  );

  return (
    <div className="space-y-5">
      {files.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-foreground">
              Changed files
            </h3>
            {generated.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowGenerated(!showGenerated)}
              >
                {showGenerated
                  ? "Hide generated/binary"
                  : "Show generated/binary"}
              </Button>
            )}
          </div>
          {treeFiles.length > 0 && (
            <ChangedFileTree
              files={treeFiles}
              selectedPath={selectedPath}
              onSelectedPathChange={selectPath}
            />
          )}
        </section>
      )}
      {primary.map(renderEntry)}
      {generated.length > 0 && (
        <details className="space-y-3" open={showGenerated}>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            Generated and binary files ({generated.length})
          </summary>
          <div className="mt-3 space-y-5">{generated.map(renderEntry)}</div>
        </details>
      )}
    </div>
  );
}

function GuideMode({
  group,
  diffStyle,
  reviewedExcerptIds,
  onToggleReviewed,
}: {
  group: WalkthroughReviewGroup;
  diffStyle: DiffStyle;
  reviewedExcerptIds: Set<string>;
  onToggleReviewed: (id: string) => void;
}) {
  const phases = group.guide.phases.filter(
    (phase) => phase.excerpts.length > 0 || phase.explanation.length > 0,
  );
  if (phases.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        This group has no authored guide.
      </p>
    );
  }
  return (
    <div className="space-y-6">
      {phases.map((phase) => (
        <details key={phase.id} open={!phase.defaultCollapsed}>
          <summary className="cursor-pointer text-base font-medium text-foreground">
            {phase.title}
          </summary>
          <div className="mt-3 space-y-4">
            <GuideBlocks blocks={phase.explanation} />
            {phase.diagram && <GuideDiagram diagram={phase.diagram} />}
            {phase.excerpts.map((excerpt) => (
              <ExcerptSection
                key={excerpt.id}
                excerpt={excerpt}
                diffStyle={diffStyle}
                reviewed={reviewedExcerptIds.has(excerpt.id)}
                onToggleReviewed={() => onToggleReviewed(excerpt.id)}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

type FetchState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: WalkthroughData };

type PersistenceState =
  | { kind: "loading" }
  | { kind: "saved" }
  | { kind: "failed"; stage: "load" | "save" };

function toggledSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function ViewerPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [groupIndex, setGroupIndex] = useState(0);
  const [mode, setMode] = useState<"normal" | "guide">("normal");
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
  const [reviewedPaths, setReviewedPaths] = useState<Set<string>>(new Set());
  const [reviewedExcerptIds, setReviewedExcerptIds] = useState<Set<string>>(
    new Set(),
  );
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [persistenceState, setPersistenceState] = useState<PersistenceState>({
    kind: "loading",
  });
  const [persistenceRetry, setPersistenceRetry] = useState(0);

  // params round-trip through persistence — treat as untrusted and let the
  // backend validate the path.
  const path =
    params !== null &&
    typeof params === "object" &&
    !Array.isArray(params) &&
    typeof params.path === "string"
      ? params.path
      : undefined;

  const load = useCallback(() => {
    setState({ kind: "loading" });
    setPersistenceReady(false);
    setPersistenceState({ kind: "loading" });
    rpc
      .call(
        "getWalkthrough",
        path === undefined ? { threadId } : { threadId, path },
      )
      .then((result) => {
        if (result.walkthrough === null) {
          setState({
            kind: "error",
            message: result.error ?? "Could not load the walkthrough.",
          });
        } else {
          setState({ kind: "ready", data: result.walkthrough });
          setGroupIndex(0);
        }
      })
      .catch(() => {
        setState({ kind: "error", message: "The walkthrough request failed." });
      });
  }, [rpc, threadId, path]);

  useEffect(() => {
    load();
  }, [load]);

  const walkthrough = state.kind === "ready" ? state.data : null;
  const storageKey = useMemo(
    () =>
      walkthrough
        ? `pr-walkthrough:v1:${walkthrough.meta.prUrl || walkthrough.meta.title}:${walkthrough.meta.headSha}`
        : null,
    [walkthrough],
  );
  const validPaths = useMemo(
    () => new Set(walkthrough?.diffFiles.map((file) => file.path) ?? []),
    [walkthrough],
  );
  const validExcerptIds = useMemo(
    () =>
      new Set(
        walkthrough?.reviewGroups.flatMap((group) =>
          group.guide.phases.flatMap((phase) =>
            phase.excerpts.map((excerpt) => excerpt.id),
          ),
        ) ?? [],
      ),
    [walkthrough],
  );
  const serializedProgress = useMemo(
    () =>
      JSON.stringify({
        mode,
        reviewedExcerptIds: [...reviewedExcerptIds].sort(),
        reviewedPaths: [...reviewedPaths].sort(),
      }),
    [mode, reviewedExcerptIds, reviewedPaths],
  );

  useEffect(() => {
    if (storageKey === null) return;
    setPersistenceReady(false);
    setPersistenceState({ kind: "loading" });
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === null) {
        setMode("normal");
        setReviewedPaths(new Set());
        setReviewedExcerptIds(new Set());
      } else {
        const parsed = JSON.parse(stored) as {
          mode?: unknown;
          reviewedExcerptIds?: unknown;
          reviewedPaths?: unknown;
        };
        setMode(parsed.mode === "guide" ? "guide" : "normal");
        setReviewedPaths(
          new Set(
            Array.isArray(parsed.reviewedPaths)
              ? parsed.reviewedPaths.filter(
                  (value): value is string =>
                    typeof value === "string" && validPaths.has(value),
                )
              : [],
          ),
        );
        setReviewedExcerptIds(
          new Set(
            Array.isArray(parsed.reviewedExcerptIds)
              ? parsed.reviewedExcerptIds.filter(
                  (value): value is string =>
                    typeof value === "string" && validExcerptIds.has(value),
                )
              : [],
          ),
        );
      }
      setPersistenceReady(true);
      setPersistenceState({ kind: "saved" });
    } catch {
      setPersistenceState({ kind: "failed", stage: "load" });
    }
  }, [persistenceRetry, storageKey, validExcerptIds, validPaths]);

  useEffect(() => {
    if (!persistenceReady || storageKey === null) return;
    try {
      window.localStorage.setItem(storageKey, serializedProgress);
      setPersistenceState({ kind: "saved" });
    } catch {
      setPersistenceState({ kind: "failed", stage: "save" });
    }
  }, [persistenceReady, serializedProgress, storageKey]);

  const retryPersistence = () => {
    if (persistenceState.kind !== "failed" || storageKey === null) return;
    if (persistenceState.stage === "load") {
      setPersistenceRetry((value) => value + 1);
      return;
    }
    try {
      window.localStorage.setItem(storageKey, serializedProgress);
      setPersistenceState({ kind: "saved" });
    } catch {
      setPersistenceState({ kind: "failed", stage: "save" });
    }
  };

  const resetUnreadableProgress = () => {
    if (storageKey === null) return;
    try {
      window.localStorage.removeItem(storageKey);
      setMode("normal");
      setReviewedPaths(new Set());
      setReviewedExcerptIds(new Set());
      setPersistenceReady(true);
      setPersistenceState({ kind: "saved" });
    } catch {
      setPersistenceState({ kind: "failed", stage: "load" });
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading walkthrough…
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-sm text-muted-foreground">{state.message}</div>
        <Button size="sm" variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  const { meta, reviewGroups, diffFiles } = state.data;
  const group = reviewGroups[Math.min(groupIndex, reviewGroups.length - 1)];
  const diffByPath = new Map(diffFiles.map((file) => [file.path, file]));
  const groupPaths =
    group?.files
      .map((file) => file.path)
      .filter((filePath) => diffByPath.has(filePath)) ?? [];
  const groupExcerpts =
    group?.guide.phases.flatMap((phase) => phase.excerpts) ?? [];
  const requiredExcerpts = groupExcerpts.filter(
    (excerpt) => excerpt.countsTowardCompletion,
  );
  const reviewedFileCount = groupPaths.filter((filePath) =>
    reviewedPaths.has(filePath),
  ).length;
  const reviewedExcerptCount = requiredExcerpts.filter((excerpt) =>
    reviewedExcerptIds.has(excerpt.id),
  ).length;
  const normalComplete =
    groupPaths.length > 0 && reviewedFileCount === groupPaths.length;
  const guideComplete =
    requiredExcerpts.length > 0 &&
    reviewedExcerptCount === requiredExcerpts.length;
  const groupReviewed = normalComplete || guideComplete;

  const toggleGroupReviewed = () => {
    setReviewedPaths((current) => {
      const next = new Set(current);
      for (const filePath of groupPaths) {
        if (groupReviewed) next.delete(filePath);
        else next.add(filePath);
      }
      return next;
    });
    setReviewedExcerptIds((current) => {
      const next = new Set(current);
      for (const excerpt of groupExcerpts) {
        if (groupReviewed) next.delete(excerpt.id);
        else next.add(excerpt.id);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="shrink-0 space-y-2 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">
              {meta.title}
            </div>
            <div className="truncate font-mono text-xs text-muted-foreground">
              {meta.headRef} → {meta.baseRef}
            </div>
            <div className="text-[11px] text-muted-foreground" aria-live="polite">
              {persistenceState.kind === "loading"
                ? "Loading local progress…"
                : persistenceState.kind === "saved"
                  ? "Local progress saved"
                  : "Local progress not saved"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setDiffStyle(diffStyle === "unified" ? "split" : "unified")
              }
            >
              {diffStyle === "unified" ? "Unified" : "Split"}
            </Button>
            {meta.prUrl && (
              <Button size="sm" variant="outline" asChild>
                <a href={meta.prUrl} target="_blank" rel="noreferrer">
                  Open PR
                </a>
              </Button>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {reviewGroups.map((g, index) => (
            <button
              key={g.id}
              type="button"
              onClick={() => setGroupIndex(index)}
              className={`max-w-56 truncate rounded-md border px-2 py-1 text-xs ${
                index === groupIndex
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              {index + 1}. {g.title}
              {(() => {
                const paths = g.files
                  .map((file) => file.path)
                  .filter((filePath) => diffByPath.has(filePath));
                const excerpts = g.guide.phases
                  .flatMap((phase) => phase.excerpts)
                  .filter((excerpt) => excerpt.countsTowardCompletion);
                const reviewed =
                  (paths.length > 0 &&
                    paths.every((filePath) => reviewedPaths.has(filePath))) ||
                  (excerpts.length > 0 &&
                    excerpts.every((excerpt) =>
                      reviewedExcerptIds.has(excerpt.id),
                    ));
                return reviewed ? " · Reviewed" : "";
              })()}
            </button>
          ))}
        </div>
      </header>
      {persistenceState.kind === "failed" && (
        <output
          className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1">
            {persistenceState.stage === "load"
              ? "Saved progress could not be read. Retry or reset it before new progress is saved."
              : "Progress is kept in this panel but could not be saved locally."}
          </span>
          <Button size="sm" variant="outline" onClick={retryPersistence}>
            Retry
          </Button>
          {persistenceState.stage === "load" && (
            <Button size="sm" variant="outline" onClick={resetUnreadableProgress}>
              Reset saved progress
            </Button>
          )}
        </output>
      )}
      {group !== undefined && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-4 p-4">
            <div className="space-y-2">
              <h2 className="text-base font-semibold text-foreground">
                {group.title}
              </h2>
              <p className="text-sm text-muted-foreground">
                Section {groupIndex + 1} of {reviewGroups.length} ·{" "}
                {group.objective}
              </p>
              <Markdown content={group.summary} />
              {group.details.map((detail, index) => (
                <Markdown key={index} content={detail} />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {(["normal", "guide"] as const).map((m) => (
                  <Button
                    key={m}
                    size="sm"
                    variant={mode === m ? "default" : "outline"}
                    onClick={() => setMode(m)}
                  >
                    {m === "normal" ? "Normal" : "Guide"}
                  </Button>
                ))}
                <span className="ml-2 text-xs text-muted-foreground">
                  {mode === "normal"
                    ? `${reviewedFileCount} of ${groupPaths.length} files viewed`
                    : `${reviewedExcerptCount} of ${requiredExcerpts.length} excerpts viewed`}
                </span>
              </div>
              <Button
                aria-pressed={groupReviewed}
                size="sm"
                variant={groupReviewed ? "secondary" : "outline"}
                onClick={toggleGroupReviewed}
              >
                {groupReviewed
                  ? "Reviewed · Normal + Guide"
                  : "Mark Normal + Guide reviewed"}
              </Button>
            </div>
            {mode === "normal" ? (
              <NormalMode
                group={group}
                diffFiles={diffFiles}
                diffStyle={diffStyle}
                reviewedPaths={reviewedPaths}
                onToggleReviewed={(filePath) =>
                  setReviewedPaths((current) => toggledSet(current, filePath))
                }
              />
            ) : (
              <GuideMode
                group={group}
                diffStyle={diffStyle}
                reviewedExcerptIds={reviewedExcerptIds}
                onToggleReviewed={(id) =>
                  setReviewedExcerptIds((current) => toggledSet(current, id))
                }
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: VIEWER_ACTION_ID,
    title: DEFAULT_TITLE,
    layout: "flush",
    component: ViewerPanel,
  });
  app.slots.messageDirective({
    id: "pr-walkthrough",
    component: WalkthroughDirective,
  });
});
