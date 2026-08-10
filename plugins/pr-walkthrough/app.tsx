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
import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { toast } from "sonner";
import type {
  rpcContract,
  WalkthroughData,
  WalkthroughDiffFile,
  WalkthroughGuideBlock,
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
      {/*
        Index keys are correct here. Blocks carry no id, and the array comes
        from the compiled walkthrough JSON: it is fixed for the life of the
        component and never reordered, inserted into, or filtered. Content
        would not be a safe key either, since two paragraphs can be identical.
      */}
      {/* oxlint-disable react/no-array-index-key */}
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
      {/* oxlint-enable react/no-array-index-key */}
    </div>
  );
}

function PatchDiff({
  patch,
  diffStyle,
}: {
  patch: string;
  diffStyle: DiffStyle;
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
      <FileDiff fileDiff={fileDiff} options={{ diffStyle }} />
    </div>
  );
}

function ExcerptSection({
  excerpt,
  diffStyle,
}: {
  excerpt: WalkthroughGuideExcerpt;
  diffStyle: DiffStyle;
}) {
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium text-foreground">{excerpt.title}</h4>
      <GuideBlocks blocks={excerpt.explanation} />
      {excerpt.binary ? (
        <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
          Binary file: {excerpt.path}
        </div>
      ) : (
        <PatchDiff patch={excerpt.patch} diffStyle={diffStyle} />
      )}
      {excerpt.comments.length > 0 && (
        <ul className="space-y-1">
          {excerpt.comments.map((comment) => (
            <li key={comment.id} className="text-xs text-muted-foreground">
              <span className="font-mono text-foreground">
                {comment.side === "additions" ? "R" : "L"}
                {comment.lineNumber}
              </span>{" "}
              — {comment.body}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NormalMode({
  group,
  diffFiles,
  diffStyle,
}: {
  group: WalkthroughReviewGroup;
  diffFiles: WalkthroughDiffFile[];
  diffStyle: DiffStyle;
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
  const primary = files.filter((entry) => !entry.diff!.generated);
  const generated = files.filter((entry) => entry.diff!.generated);
  const treeFiles = useMemo(
    () =>
      files
        .filter((entry) => showGenerated || !entry.diff!.generated)
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
      {entry.file.note && (
        <p className="text-sm text-muted-foreground">{entry.file.note}</p>
      )}
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
      {treeFiles.length > 0 && (
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
                {showGenerated ? "Hide generated" : "Show generated"}
              </Button>
            )}
          </div>
          <ChangedFileTree
            files={treeFiles}
            selectedPath={selectedPath}
            onSelectedPathChange={selectPath}
          />
        </section>
      )}
      {primary.map(renderEntry)}
      {generated.length > 0 && (
        <details className="space-y-3" open={showGenerated}>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
            Generated files ({generated.length})
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
}: {
  group: WalkthroughReviewGroup;
  diffStyle: DiffStyle;
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
            {phase.excerpts.map((excerpt) => (
              <ExcerptSection
                key={excerpt.id}
                excerpt={excerpt}
                diffStyle={diffStyle}
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

function ViewerPanel({ threadId, params }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [groupIndex, setGroupIndex] = useState(0);
  const [mode, setMode] = useState<"normal" | "guide">("normal");
  const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");

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
    void (async () => {
      try {
        const result = await rpc.call(
          "getWalkthrough",
          path === undefined ? { threadId } : { threadId, path },
        );
        if (result.walkthrough === null) {
          setState({
            kind: "error",
            message: result.error ?? "Could not load the walkthrough.",
          });
        } else {
          setState({ kind: "ready", data: result.walkthrough });
          setGroupIndex(0);
        }
      } catch {
        setState({ kind: "error", message: "The walkthrough request failed." });
      }
    })();
  }, [rpc, threadId, path]);

  useEffect(() => {
    load();
  }, [load]);

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
            </button>
          ))}
        </div>
      </header>
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
              {/* Fixed list of strings from the compiled JSON; see GuideBlocks. */}
              {/* oxlint-disable react/no-array-index-key */}
              {group.details.map((detail, index) => (
                <Markdown key={index} content={detail} />
              ))}
              {/* oxlint-enable react/no-array-index-key */}
            </div>
            <div className="flex gap-1">
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
            </div>
            {mode === "normal" ? (
              <NormalMode
                group={group}
                diffFiles={diffFiles}
                diffStyle={diffStyle}
              />
            ) : (
              <GuideMode group={group} diffStyle={diffStyle} />
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
