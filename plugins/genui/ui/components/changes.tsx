// Changes: the files changed in the reply's thread's checkout, read from BB
// (project_changes), each opening BB's own diff viewer. What a reply first
// showed is kept per block, so an old reply keeps meaning what it meant; a
// commit's changes never change and are read live.
import { useId, useState, type ReactNode } from "react";
import { experimental_Diff as HostDiff, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  CHANGE_LABEL,
  CHANGE_LETTER,
  changeTotals,
  parseChangesTarget,
  parsePathFilter,
  splitPath,
  type ChangedFile,
  type ChangeKind,
  type ChangesResult,
  type ChangesScope,
  type ChangesTarget,
  type ChangesView,
  type FilePatch,
  type PatchesResult,
} from "../../core/project";
import type { rpcContract } from "../../server";
import { useUiRuntime } from "../runtime";
import { formatNumber, TONE_PILL, type Props, type Tone } from "../values";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight } from "./motion";
import { ratioBlocks } from "./project-logic";
import {
  FailureLine,
  Freshness,
  ICON_BUTTON,
  LoadingRows,
  NeedsThread,
  Panel,
  QuietLine,
  ShowAll,
  useNow,
  useProjectQuery,
} from "./projectKit";

/** Files listed before "Show all"; a list only a few longer shows whole. */
const COLLAPSED_FILES = 12;
const COLLAPSE_FROM = 16;

const KIND_TONE: Record<ChangeKind, Tone> = {
  added: "good",
  copied: "info",
  deleted: "bad",
  modified: "warn",
  renamed: "info",
  type_changed: "neutral",
};

/** The `target` the RPC takes: null for the branch, else as written. */
function wireTarget(target: ChangesTarget): string | null {
  return target.kind === "branch" ? null : target.kind === "uncommitted" ? "uncommitted" : target.sha;
}

export function Changes({ props }: { props: Props }) {
  const { threadId, blockKey } = useUiRuntime();
  const target = parseChangesTarget(props.target);
  const paths = parsePathFilter(props.paths);
  if (!target.ok) return <ErrorLine message={target.error} />;
  if (!paths.ok) return <ErrorLine message={paths.error} />;
  if (threadId === null) {
    return (
      <NeedsThread icon="FileDiff">
        <span className="font-medium text-foreground">Changes</span> needs a thread: in a reply it lists the files changed in that
        thread's checkout{target.value.kind === "commit" ? ` by commit ${target.value.sha.slice(0, 7)}` : ""}.
      </NeedsThread>
    );
  }
  return <ChangesPanel threadId={threadId} blockKey={blockKey} target={target.value} paths={paths.value} />;
}

function useChanges(threadId: string, blockKey: string | null, target: ChangesTarget, paths: readonly string[] | null) {
  const rpc = useRpc<typeof rpcContract>();
  // A commit cannot change: nothing to keep, nothing to refresh.
  const keep = target.kind === "commit" ? null : blockKey;
  return useProjectQuery<ChangesResult>(
    `changes\0${threadId}\0${keep ?? ""}\0${JSON.stringify(target)}\0${JSON.stringify(paths)}`,
    (refresh) =>
      rpc.call("project_changes", { threadId, target: wireTarget(target), paths: paths === null ? null : [...paths], blockKey: keep, refresh }),
  );
}

function ChangesPanel({
  threadId,
  blockKey,
  target,
  paths,
}: {
  threadId: string;
  blockKey: string | null;
  target: ChangesTarget;
  paths: readonly string[] | null;
}) {
  const { query, refresh } = useChanges(threadId, blockKey, target, paths);
  const now = useNow();
  const answer = query.status === "ready" ? query.answer : null;
  const view = answer?.ok ? answer : null;
  return (
    <Panel
      label="Changes"
      header={
        <>
          {view === null ? <TargetHeading target={target} /> : <ScopeHeading scope={view.scope} />}
          {view === null ? null : <Totals view={view} />}
          {view === null || view.scope.kind === "commit" ? null : (
            <Freshness at={view.takenAt} stored={view.stored} refreshing={query.status === "ready" && query.refreshing} onRefresh={refresh} now={now} />
          )}
        </>
      }
    >
      {answer === null ? (
        <LoadingRows label="Loading changes" />
      ) : !answer.ok ? (
        <FailureLine failure={answer} />
      ) : (
        <FileList threadId={threadId} target={target} view={answer} />
      )}
    </Panel>
  );
}

/**
 * A commit's changes inside a Commits row: the same list without its own
 * frame. Commits are immutable, so this is always read live.
 */
export function CommitChanges({ threadId, sha }: { threadId: string; sha: string }) {
  const target: ChangesTarget = { kind: "commit", sha };
  const { query } = useChanges(threadId, null, target, null);
  if (query.status === "loading") return <LoadingRows label={`Loading the changes of ${sha.slice(0, 7)}`} rows={2} />;
  const answer = query.answer;
  if (!answer.ok) return <FailureLine failure={answer} />;
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 px-3 pb-1 pt-0.5 text-xs leading-5 text-muted-foreground">
        <Totals view={answer} />
      </div>
      <FileList threadId={threadId} target={target} view={answer} />
    </div>
  );
}

function Branch({ name }: { name: string }) {
  return (
    <span className="min-w-0 truncate font-mono text-[11.5px] font-medium text-foreground" title={name}>
      {name}
    </span>
  );
}

function TargetHeading({ target }: { target: ChangesTarget }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon name="FileDiff" aria-hidden className="size-3.5 shrink-0" />
      <span className="font-medium text-foreground">
        {target.kind === "uncommitted" ? "Uncommitted changes" : target.kind === "commit" ? `Commit ${target.sha.slice(0, 7)}` : "Changes"}
      </span>
    </span>
  );
}

/** "feat/x vs main · incl. uncommitted", "uncommitted on main", "commit a1b2c3d Subject". */
function ScopeHeading({ scope }: { scope: ChangesScope }) {
  let body: ReactNode;
  switch (scope.kind) {
    case "branch": {
      const name = scope.branch ?? (scope.head === null ? "HEAD" : `detached ${scope.head}`);
      body = scope.onBase ? (
        <>
          <Branch name={name} />
          <span className="shrink-0">uncommitted</span>
        </>
      ) : (
        <>
          <Branch name={name} />
          <span className="shrink-0">vs</span>
          <Branch name={scope.base} />
          <span className="shrink-0">· incl. uncommitted</span>
        </>
      );
      break;
    }
    case "uncommitted":
      body = (
        <>
          <span className="shrink-0 font-medium text-foreground">Uncommitted</span>
          {scope.branch === null ? null : (
            <>
              <span className="shrink-0">on</span>
              <Branch name={scope.branch} />
            </>
          )}
          {scope.unborn ? <span className="shrink-0">· no commits yet</span> : null}
        </>
      );
      break;
    case "commit":
      body = (
        <>
          <span className="shrink-0 font-mono text-[11.5px] font-medium text-foreground">{scope.sha.slice(0, 7)}</span>
          {scope.subject === null ? null : (
            <span className="min-w-0 truncate text-foreground" title={scope.subject}>
              {scope.subject}
            </span>
          )}
        </>
      );
      break;
  }
  return (
    <span className="flex min-w-0 max-w-full items-center gap-1.5">
      <Icon name={scope.kind === "commit" ? "FileDiff" : "GitBranch"} aria-hidden className="size-3.5 shrink-0" />
      {body}
    </span>
  );
}

function Totals({ view }: { view: ChangesView }) {
  const totals = changeTotals(view.files);
  // An empty list says so in its body; "0 files +0 −0" would only repeat it.
  if (totals.files === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 tabular-nums">
      <span>
        {formatNumber(totals.files)} file{totals.files === 1 ? "" : "s"}
        {view.filter === null ? "" : ` of ${formatNumber(view.totalFiles)}`}
      </span>
      <span className="text-success">+{formatNumber(totals.additions)}</span>
      <span className="text-destructive">−{formatNumber(totals.deletions)}</span>
    </span>
  );
}

function emptySentence(view: ChangesView): string {
  if (view.filter !== null && view.totalFiles > 0) return `None of the ${view.totalFiles} changed files is under ${view.filter.join(", ")}.`;
  switch (view.scope.kind) {
    case "branch":
      return view.scope.onBase ? "No uncommitted changes." : `No changes against ${view.scope.base}.`;
    case "uncommitted":
      return "No uncommitted changes.";
    case "commit":
      return "This commit changes no files.";
  }
}

function FileList({ threadId, target, view }: { threadId: string; target: ChangesTarget; view: ChangesView }) {
  const [expanded, setExpanded] = useState(false);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  if (view.files.length === 0) return <QuietLine className="px-3 py-2.5">{emptySentence(view)}</QuietLine>;
  const collapsed = !expanded && view.files.length >= COLLAPSE_FROM;
  const shown = collapsed ? view.files.slice(0, COLLAPSED_FILES) : view.files;
  const patches = new Map(view.patches.map((patch) => [patch.path, patch]));
  return (
    <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="min-w-0">
        {view.filter === null ? null : (
          <QuietLine icon="Filter" className="border-b border-border/60 px-3 py-1.5">
            Only {view.filter.join(", ")}
          </QuietLine>
        )}
        <ul aria-label="Changed files" className="m-0 flex min-w-0 list-none flex-col p-0">
          {shown.map((file) => (
            <FileRow
              key={file.path}
              threadId={threadId}
              target={target}
              file={file}
              patch={patches.get(file.path) ?? null}
              livePatches={view.livePatches}
              stored={view.stored}
            />
          ))}
        </ul>
        {collapsed ? <ShowAll count={view.files.length} noun="files" onClick={() => setExpanded(true)} /> : null}
        {view.listTruncated ? (
          <QuietLine icon="Info" className="border-t border-border/60 px-3 py-2">
            {view.stored ? "BB listed, or this snapshot kept, only part of the changed files." : "BB listed only part of the changed files."}
          </QuietLine>
        ) : null}
      </div>
    </div>
  );
}

function KindMark({ file }: { file: ChangedFile }) {
  const label = `${CHANGE_LABEL[file.kind]}${file.untracked ? ", untracked" : ""}`;
  return (
    <span
      title={label}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] font-semibold leading-none",
        TONE_PILL[KIND_TONE[file.kind]],
      )}
    >
      <span aria-hidden>{file.untracked ? "U" : CHANGE_LETTER[file.kind]}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** GitHub's five blocks: the file's mix of added and removed lines. */
function RatioBar({ additions, deletions }: { additions: number; deletions: number }) {
  const blocks = ratioBlocks(additions, deletions);
  const colors = [
    ...Array<string>(blocks.added).fill("bg-success"),
    ...Array<string>(blocks.removed).fill("bg-destructive"),
    ...Array<string>(blocks.neutral).fill("bg-muted"),
  ];
  return (
    <span aria-hidden className="hidden shrink-0 gap-px min-[420px]:flex">
      {colors.map((color, index) => (
        <span key={index} className={cn("size-1.5 rounded-[1px]", color)} />
      ))}
    </span>
  );
}

function FileRow({
  threadId,
  target,
  file,
  patch,
  livePatches,
  stored,
}: {
  threadId: string;
  target: ChangesTarget;
  file: ChangedFile;
  patch: FilePatch | null;
  livePatches: boolean;
  stored: boolean;
}) {
  const { openFile } = useUiRuntime();
  const rise = useEntrance<HTMLLIElement>(RISE);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  if (open && !mounted) setMounted(true);
  const { directory, name } = splitPath(file.path);
  const counted = file.diff !== "binary";
  return (
    <li ref={rise} className="min-w-0 border-b border-border/60 last:border-b-0">
      <div className="group/file flex min-w-0 items-center pr-1.5 transition-colors duration-150 hover:bg-state-hover">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-diff`}
          aria-label={`${file.path}${file.previousPath === null ? "" : ` (from ${file.previousPath})`}, ${CHANGE_LABEL[file.kind].toLowerCase()}${file.untracked ? ", untracked" : ""}, ${counted ? `${file.additions} added, ${file.deletions} removed` : "binary"}`}
          onClick={() => setOpen((value) => !value)}
          className={cn("flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-1.5 pl-2 pr-1 text-left", FOCUS_RING)}
        >
          <Icon
            name="ChevronRight"
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
              open && "rotate-90",
            )}
          />
          <KindMark file={file} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-baseline font-mono text-xs leading-5" title={file.path}>
              <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
              <span className={cn("max-w-full shrink-0 truncate text-foreground", file.kind === "deleted" && "line-through decoration-muted-foreground/60")}>
                {name}
              </span>
            </span>
            {file.previousPath === null ? null : (
              <span className="truncate font-mono text-[11px] leading-4 text-muted-foreground" title={file.previousPath}>
                from {file.previousPath}
              </span>
            )}
          </span>
          {counted ? (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums">
              <span className={file.additions === 0 ? "text-muted-foreground/70" : "text-success"}>+{formatNumber(file.additions)}</span>
              <span className={file.deletions === 0 ? "text-muted-foreground/70" : "text-destructive"}>−{formatNumber(file.deletions)}</span>
              <RatioBar additions={file.additions} deletions={file.deletions} />
            </span>
          ) : (
            <span className="shrink-0 text-[11px] text-muted-foreground">binary</span>
          )}
        </button>
        {openFile === null || file.kind === "deleted" ? null : (
          <button
            type="button"
            title={`Open ${file.path}`}
            aria-label={`Open ${file.path}`}
            onClick={async () => {
              if (!(await openFile(file.path))) toast.error(`Couldn't open ${file.path}`);
            }}
            className={cn(ICON_BUTTON, "opacity-70 group-hover/file:opacity-100 focus-visible:opacity-100")}
          >
            <Icon name="FileText" aria-hidden className="size-3.5" />
          </button>
        )}
      </div>
      <div id={`${id}-diff`} role="region" aria-label={`Diff of ${file.path}`} hidden={!open} className={open ? "block" : "hidden"}>
        {mounted ? <FileDiff threadId={threadId} target={target} file={file} patch={patch} livePatches={livePatches} stored={stored} /> : null}
      </div>
    </li>
  );
}

function DiffFrame({ children }: { children: ReactNode }) {
  return <div className="max-h-96 min-w-0 overflow-auto border-t border-border/60 bg-background text-xs">{children}</div>;
}

function FileDiff({
  threadId,
  target,
  file,
  patch,
  livePatches,
  stored,
}: {
  threadId: string;
  target: ChangesTarget;
  file: ChangedFile;
  patch: FilePatch | null;
  livePatches: boolean;
  stored: boolean;
}) {
  if (file.diff === "binary") return <DiffNote icon="File">Binary file: there is no text diff to show.</DiffNote>;
  if (file.diff === "too-large") return <DiffNote icon="Info">BB doesn't show this diff: the file is too large.</DiffNote>;
  if (patch !== null) return <PatchView patch={patch} />;
  if (!livePatches) {
    return (
      <DiffNote icon="Info">
        {stored ? "This diff was too large to keep with the snapshot. Refresh to see the current one." : "BB sent no diff for this file."}
      </DiffNote>
    );
  }
  return <LivePatch threadId={threadId} target={target} path={file.path} />;
}

function DiffNote({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="border-t border-border/60 bg-surface-recessed/50">
      <QuietLine icon={icon} className="px-3 py-2">
        {children}
      </QuietLine>
    </div>
  );
}

function PatchView({ patch }: { patch: FilePatch }) {
  if (patch.patch.trim() === "") return <DiffNote icon="Info">No line changes: only the file's mode or name changed.</DiffNote>;
  return (
    <>
      <DiffFrame>
        <HostDiff patch={patch.patch} path={patch.path} overflow="scroll" />
      </DiffFrame>
      {patch.truncated ? <DiffNote icon="Info">BB shortened this diff; open the file for all of it.</DiffNote> : null}
    </>
  );
}

function LivePatch({ threadId, target, path }: { threadId: string; target: ChangesTarget; path: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { query } = useProjectQuery<PatchesResult>(`patch\0${threadId}\0${JSON.stringify(target)}\0${path}`, () =>
    rpc.call("project_patches", { threadId, target: wireTarget(target), paths: [path] }),
  );
  if (query.status === "loading") return <LoadingRows label={`Loading the diff of ${path}`} rows={2} />;
  const answer = query.answer;
  if (!answer.ok) return <DiffNote icon="AlertCircle">{answer.message}</DiffNote>;
  const patch = answer.patches.find((candidate) => candidate.path === path);
  return patch === undefined ? <DiffNote icon="Info">BB has no diff for this file any more.</DiffNote> : <PatchView patch={patch} />;
}
