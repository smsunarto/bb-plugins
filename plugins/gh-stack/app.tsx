// bb-plugin-gh-stack — frontend: a thread panel that visualizes the
// thread's stacked PRs (gh stack) and runs sync / submit / create.
//
// Layout: one rail. Uncommitted work sits at the top, then a composer row
// that stacks a new layer on top (or creates the stack when there is none),
// then the branches top-first, then the trunk anchor. Every row expands into
// its changed-file tree with +/− deltas.
import "./app.css";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { ChangedFileTree } from "@/components/stack/changed-file-tree";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type StackResult = Awaited<ReturnType<Rpc["call"]>> extends infer R
  ? Extract<R, { stack: unknown }>
  : never;
type StackView = NonNullable<StackResult["stack"]>;
type StackBranch = StackView["branches"][number];
type ChangeSet = NonNullable<StackResult["pending"]>;
type Settings = StackResult["settings"];
type MergeMethod = "squash" | "merge" | "rebase";

// Merge is the panel's one green action, matching the open-PR green the rail
// already speaks. Same solid green in both themes — laid over a Button
// variant's own colors via tailwind-merge.
const MERGE_BUTTON_CLASSES =
  "bg-green-600 text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600";

// The merge dialog's method choice. Squash leads: a stack is written so that
// each layer reads as one commit on the trunk, which is what it produces.
const MERGE_METHODS: { value: MergeMethod; label: string; effect: string }[] = [
  {
    value: "squash",
    label: "Squash",
    effect: "each branch lands as a single commit",
  },
  {
    value: "merge",
    label: "Merge commit",
    effect: "every commit is kept, under one merge commit per branch",
  },
  {
    value: "rebase",
    label: "Rebase",
    effect: "every commit is replayed onto the base",
  },
];

// Octicon paths (16×16), extracted from GitHub's stack widget.
const OCTICONS = {
  prDraft:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  merge:
    "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z",
  dot: "M4 8a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm4-2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  plus: "M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z",
  chevronRight: "M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z",
  chevronDown:
    "M12.78 6.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 7.28a.75.75 0 0 1 1.06-1.06L8 9.94l3.72-3.72a.75.75 0 0 1 1.06 0Z",
} as const;

function Octicon({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={16}
      height={16}
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d={path} />
    </svg>
  );
}

function branchIcon(branch: StackBranch): { path: string; tone: string } {
  const pr = branch.pr;
  if (!pr) return { path: OCTICONS.dot, tone: "text-muted-foreground" };
  if (branch.isMerged || pr.state === "MERGED")
    return { path: OCTICONS.merge, tone: "text-purple-600 dark:text-purple-400" };
  if (pr.state === "QUEUED")
    return { path: OCTICONS.pr, tone: "text-amber-600 dark:text-amber-400" };
  if (pr.isDraft)
    return { path: OCTICONS.prDraft, tone: "text-muted-foreground" };
  return { path: OCTICONS.pr, tone: "text-green-600 dark:text-green-400" };
}

// GitHub-style status pill (h 20px, px 6px, radius full, 12px/500). For open
// PRs it doubles as the draft⇄ready toggle.
function StatusPill({
  pr,
  busy,
  onToggle,
}: {
  pr: NonNullable<StackBranch["pr"]>;
  busy: boolean;
  onToggle: (() => void) | null;
}) {
  let label: string;
  let tone: string;
  if (pr.state === "MERGED") {
    label = "Merged";
    tone = "bg-purple-600/10 text-purple-600 dark:text-purple-400";
  } else if (pr.state === "QUEUED") {
    label = "Queued";
    tone = "bg-amber-600/10 text-amber-600 dark:text-amber-400";
  } else if (pr.isDraft) {
    label = "Draft";
    tone = "bg-muted text-muted-foreground";
  } else {
    label = "Open";
    tone = "bg-green-600/10 text-green-600 dark:text-green-400";
  }
  const pill = `inline-flex h-5 items-center rounded-full border border-transparent px-1.5 text-xs font-medium leading-none ${tone}`;
  if (!onToggle) {
    return <span className={pill}>{label}</span>;
  }
  // The label is already the state the click asked for — the toggle is
  // optimistic — so an in-flight write only dims the pill and blocks a second
  // click. Swapping in a spinner here would be the flicker it is meant to end.
  return (
    <button
      type="button"
      className={`${pill} cursor-pointer hover:border-border disabled:cursor-default ${busy ? "opacity-70" : ""}`}
      disabled={busy}
      title={pr.isDraft ? "Mark ready for review" : "Convert to draft"}
      onClick={onToggle}
    >
      {label}
    </button>
  );
}

// Shared rail row: [16px icon column][content], with the connector segment
// running below the icon down to the next row.
function RailRow({
  icon,
  iconTone,
  accent,
  highlighted,
  children,
}: {
  icon: string;
  iconTone?: string;
  accent?: boolean;
  highlighted?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative mx-2 rounded-md ${highlighted ? "bg-muted" : "hover:bg-muted/50"}`}
    >
      {accent ? (
        <div
          className="absolute -left-2 top-1 bottom-1 w-1 rounded-md bg-blue-500"
          aria-hidden
        />
      ) : null}
      <div className="relative grid grid-cols-[16px_1fr] gap-x-2 px-2 py-1.5">
        {/* connector segment below the icon, GitHub-exact */}
        <div
          className="absolute bottom-0 left-[15px] top-8 w-[2px] bg-border"
          aria-hidden
        />
        <span className={`mt-0.5 ${iconTone ?? "text-muted-foreground"}`}>
          <Octicon path={icon} />
        </span>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}

// Branch names display at most this many characters; the tooltip carries the
// full name.
const BRANCH_DISPLAY_CHARS = 25;

function shortBranchName(name: string): string {
  return name.length > BRANCH_DISPLAY_CHARS
    ? `${name.slice(0, BRANCH_DISPLAY_CHARS)}…`
    : name;
}

// What a branch row prints under its title. Pass a shortened `name` for the
// visible copy; the default full name is for tooltips.
function sublineLabel(branch: StackBranch, name = branch.name): string {
  return branch.pr
    ? `#${branch.pr.number} · ${name}`
    : `${name} · no pull request yet`;
}

// +N −M, in the diff colors. Rendered next to a file count.
function DeltaChip({ change }: { change: ChangeSet }) {
  const fileCount = change.files.length;
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs leading-4 tabular-nums">
      <span className="text-muted-foreground">
        {fileCount}
        {change.truncated ? "+" : ""} file{fileCount === 1 ? "" : "s"}
      </span>
      <span className="text-green-600 dark:text-green-400">
        +{change.additions}
      </span>
      <span className="text-red-600 dark:text-red-400">−{change.deletions}</span>
    </span>
  );
}

// A row's changed-file tree, plus the caret that toggles it. Returns null
// when the diff could not be computed or is empty. relative, so it stays
// clickable above a row's stretched PR link.
function ChangeDisclosure({
  change,
  expanded,
  onToggle,
  label,
}: {
  change: ChangeSet | null;
  expanded: boolean;
  onToggle: () => void;
  label: string;
}) {
  if (!change || change.files.length === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      title={expanded ? `Hide ${label}` : `Show ${label}`}
      className="relative inline-flex shrink-0 items-center gap-1 rounded text-muted-foreground hover:text-foreground"
    >
      <Octicon
        path={expanded ? OCTICONS.chevronDown : OCTICONS.chevronRight}
        className="size-3.5"
      />
      <DeltaChip change={change} />
    </button>
  );
}

function ChangeTree({ change }: { change: ChangeSet }) {
  return (
    <div className="mt-1.5 space-y-1">
      <ChangedFileTree files={change.files} />
      {change.truncated ? (
        <p className="text-[11px] text-muted-foreground">
          Only the first {change.files.length} files are listed.
        </p>
      ) : null}
    </div>
  );
}

// Whether a click should stay in the app: modified clicks (cmd, ctrl, shift,
// middle button) are left to the browser, which opens the anchor's href —
// the PR's web URL — in a real tab.
function isPlainClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  );
}

function BranchRow({
  branch,
  prBusy,
  expanded,
  onToggleExpanded,
  onToggleDraft,
  onCheckout,
}: {
  branch: StackBranch;
  prBusy: number | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleDraft: (pr: NonNullable<StackBranch["pr"]>) => void;
  onCheckout: (branchName: string) => void;
}) {
  const pr = branch.pr;
  const title = pr?.title ?? branch.name;
  const canToggle = pr !== null && pr.state === "OPEN";
  const icon = branchIcon(branch);
  return (
    <RailRow
      icon={icon.path}
      iconTone={icon.tone}
      accent={branch.isCurrent}
      highlighted={branch.isCurrent}
    >
      {/* Stretched overlay: a plain click checks the branch out in the
          workspace. Rows with a PR keep an anchor so cmd/middle-click still
          opens github.com; the current branch gets no overlay at all.
          Controls that must stay clickable (status pill, disclosure caret,
          file tree) sit above it — they are position:relative, so they paint
          over the overlay. */}
      {branch.isCurrent ? null : pr ? (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onCheckout(branch.name);
          }}
          title={`Check out ${branch.name}`}
          aria-label={`Check out ${branch.name}`}
          className="absolute inset-0 rounded-md"
        />
      ) : (
        <button
          type="button"
          onClick={() => onCheckout(branch.name)}
          title={`Check out ${branch.name}`}
          aria-label={`Check out ${branch.name}`}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
      )}
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">
          {title}
        </span>
        <span className="relative flex shrink-0 items-center gap-1.5">
          {branch.needsRebase ? (
            <span className="rounded border border-destructive/50 px-1 text-[10px] font-medium uppercase tracking-wide leading-4 text-destructive">
              needs rebase
            </span>
          ) : null}
          {pr ? (
            <StatusPill
              pr={pr}
              busy={prBusy === pr.number}
              onToggle={canToggle ? () => onToggleDraft(pr) : null}
            />
          ) : null}
        </span>
      </div>
      {/* One line, never wrapped: the chip follows the name in normal flow,
          and the name is the only cell that can shrink — a narrow panel
          ellipsizes it instead of clipping the file count and deltas. Mono,
          like the chip, so a name capped at BRANCH_DISPLAY_CHARS puts every
          row's chip in the same place. */}
      <div className="flex items-center gap-x-2 overflow-hidden text-xs leading-4 text-muted-foreground">
        <span
          className="min-w-0 truncate font-mono tabular-nums"
          title={sublineLabel(branch)}
        >
          {sublineLabel(branch, shortBranchName(branch.name))}
        </span>
        {!branch.isMerged && !branch.isQueued && (branch.aheadOfRemote ?? 0) > 0 ? (
          <span className="shrink-0 rounded border border-amber-600/50 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            {branch.aheadOfRemote} unpushed
          </span>
        ) : null}
        <ChangeDisclosure
          change={branch.diff}
          expanded={expanded}
          onToggle={onToggleExpanded}
          label={`files changed in ${branch.name}`}
        />
      </div>
      {expanded && branch.diff ? (
        <div className="relative">
          <ChangeTree change={branch.diff} />
        </div>
      ) : null}
    </RailRow>
  );
}

// Keep in sync with deriveBranchName in server.ts (authoritative copy).
const STOPWORDS = new Set([
  "a", "an", "and", "for", "in", "of", "on", "the", "to", "with",
]);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0 && !STOPWORDS.has(word))
    .slice(0, 5)
    .join("-")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

// "feat(api)!: add rate limiting" → type "feat", scope "api", subject "add
// rate limiting".
const CONVENTIONAL_HEAD = /^\s*([A-Za-z]+)\s*(?:\(([^)]*)\))?\s*!?\s*:\s*(.+)$/;

// Under Conventional Commits the type and the scope lead the slug; a name
// without a type just slugifies.
function deriveBranchName(name: string, conventional: boolean): string {
  if (!conventional) return slugify(name);
  const match = CONVENTIONAL_HEAD.exec(name);
  const slug = slugify(match ? match[3] : name);
  if (!slug) return "";
  if (!match) return slug;
  const scope = match[2] ? slugify(match[2]) : "";
  const type = match[1].toLowerCase();
  return scope ? `${type}-${scope}-${slug}` : `${type}-${slug}`;
}

// The namespace new stacks land in until the gear popup says otherwise.
// Keep in sync with DEFAULT_BRANCH_PREFIX in server.ts.
const DEFAULT_BRANCH_PREFIX = "bb/";

// A prefix is a branch namespace, so it ends on a separator: "bb" and "bb/"
// name the same one. Keep in sync with withBranchSeparator in server.ts.
function withBranchSeparator(prefix: string): string {
  if (!prefix) return "";
  return /[/_-]$/.test(prefix) ? prefix : `${prefix}/`;
}

// The next layer, at the top of the rail: the name field, and below it the
// same subline a branch row has — "#N · branch" plus the changed files. The
// files are the uncommitted ones, since `gh stack add` carries the working
// tree onto the new branch; before a name is typed they are still just the
// working tree. With a stack the row stacks a branch on top (gh stack add);
// without one it creates the stack (gh stack init).
function LayerComposer({
  mode,
  busy,
  suggesting,
  autoStacking,
  pending,
  prefix,
  conventional,
  nextNumber,
  expanded,
  onToggleExpanded,
  onSubmit,
  onSuggest,
  onAutoStack,
}: {
  mode: "init" | "add";
  busy: boolean;
  suggesting: boolean;
  autoStacking: boolean;
  pending: ChangeSet | null;
  prefix: string | null;
  conventional: boolean;
  nextNumber: number | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  // Resolves true when the layer was created, so the field can clear.
  onSubmit: (name: string, branch: string) => Promise<boolean>;
  onSuggest: () => Promise<string>;
  onAutoStack: () => void;
}) {
  const [name, setName] = useState("");
  const slug = deriveBranchName(name, conventional);
  const branch = slug ? `${withBranchSeparator(prefix ?? "")}${slug}` : "";
  const canSubmit = slug.length > 0 && !busy;
  const submitLabel = mode === "init" ? "Create stack" : "Stack";
  const busyLabel = mode === "init" ? "Creating…" : "Stacking…";
  return (
    <RailRow icon={OCTICONS.plus}>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          // Clear only on success: a failed create leaves the name to retry
          // or edit.
          void (async () => {
            const created = await onSubmit(name.trim(), branch);
            if (created) setName("");
          })();
        }}
      >
        {/* The field keeps its own width floor so it stays readable in a
            narrow panel; the button pair wraps below it instead. grow-[99]
            against the pair's grow-1: on one line the field soaks up the
            slack and the buttons hug their content. */}
        <div className="relative w-40 min-w-40 grow-[99] basis-40">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              conventional
                ? mode === "init"
                  ? 'e.g. "feat(api): add rate limiting"'
                  : 'e.g. "feat(api): add metrics for the rate limiter"'
                : mode === "init"
                  ? 'e.g. "Add rate limiting to the API"'
                  : 'e.g. "Add metrics for the rate limiter"'
            }
            // Room for the suggest button plus a gap, so typed text never
            // runs up against it.
            className="h-7 w-full pr-9 text-sm"
            disabled={busy}
          />
          {/* Fills the field from the thread's agent, so it rides inside the
              field's trailing edge rather than reading as a fourth action.
              Button drops `title`, so the tooltip rides on a wrapper. */}
          {/* flex, so the wrapper hugs the button instead of inheriting a
              line box that would push it above centre. */}
          <span
            title="Suggest a name from the workspace changes"
            className="absolute right-1 top-1/2 flex -translate-y-1/2"
          >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              // 20px inside a 28px field: 4px clear of the border all round.
              className="size-5 rounded-sm px-0 text-muted-foreground"
              aria-label="Suggest a name from the workspace changes"
              disabled={busy || suggesting}
              onClick={() => {
                void (async () => {
                  const suggested = await onSuggest();
                  if (suggested) setName(suggested);
                })();
              }}
            >
              <Icon
                name={suggesting ? "Spinner" : "Sparkles"}
                className={suggesting ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </Button>
          </span>
        </div>
        {/* One layer at a time is the form; Auto Stack hands the whole split
            to the thread's agent instead. The pair moves as one unit:
            beside the field while it fits, else onto its own full-width row
            split 50:50 (each button flex-1). */}
        <div className="flex min-w-fit flex-1 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 flex-1 gap-1.5"
            disabled={busy || autoStacking}
            onClick={onAutoStack}
          >
            <Icon name="MagicWand" className="size-3.5" />
            {autoStacking ? "Summoning…" : "Auto Stack"}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="h-7 flex-1"
            disabled={!canSubmit}
          >
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </form>
      {/* Same subline as a branch row: "#N · branch", then the file count;
          only the name shrinks. */}
      <div className="mt-1 flex items-center gap-x-2 overflow-hidden text-xs leading-4 text-muted-foreground">
        <span
          className="min-w-0 truncate font-mono tabular-nums"
          title={`${nextNumber !== null ? `#${nextNumber} · ` : ""}${branch || "working tree"}`}
        >
          {nextNumber !== null ? `#${nextNumber} · ` : ""}
          {branch ? shortBranchName(branch) : "working tree"}
        </span>
        <ChangeDisclosure
          change={pending}
          expanded={expanded}
          onToggle={onToggleExpanded}
          label="uncommitted files"
        />
      </div>
      {expanded && pending ? <ChangeTree change={pending} /> : null}
    </RailRow>
  );
}

// A switch in the host's tokens — the vendored component set ships no
// checkbox or switch, and one control does not justify another dependency.
function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-input transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
        checked ? "bg-foreground" : "bg-muted"
      }`}
    >
      {/* top is explicit: an absolutely positioned child should not depend on
          the flex parent's static-position alignment. Track 20px less two 1px
          borders leaves 18px, so a 14px knob centers at 2px. */}
      <span
        aria-hidden
        className={`absolute top-[2px] size-3.5 rounded-full bg-background transition-transform ${
          checked ? "translate-x-[19px]" : "translate-x-[3px]"
        }`}
      />
    </button>
  );
}

// The gear popup: the two conventions the composer follows. Both are global
// to the plugin, not per repository — an empty prefix falls back to the
// namespace the workspace's own branches share.
function SettingsDialog({
  open,
  onOpenChange,
  settings,
  detectedPrefix,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings;
  detectedPrefix: string | null;
  onSave: (next: Settings) => Promise<boolean>;
}) {
  const [prefix, setPrefix] = useState(settings.branchPrefix);
  const [conventional, setConventional] = useState(settings.conventionalCommits);
  const [saving, setSaving] = useState(false);

  // Seed the draft when the popup opens, and only then: the payload behind
  // `settings` is a new object on every poll, so depending on it here would
  // wipe what the user is typing every time the panel revalidates.
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  useEffect(() => {
    if (open) {
      setPrefix(latestSettings.current.branchPrefix);
      setConventional(latestSettings.current.conventionalCommits);
    }
  }, [open]);

  // What the composer would build from an example title under this draft.
  const exampleTitle = conventional
    ? "feat(api): add rate limiting"
    : "Add rate limiting to the API";
  // Preview the namespace the way the server will store it, so a prefix
  // typed without its trailing separator still reads as one here.
  const examplePrefix = withBranchSeparator(prefix.trim()) || detectedPrefix || "";
  const exampleBranch = `${examplePrefix}${deriveBranchName(exampleTitle, conventional)}`;

  const save = async () => {
    setSaving(true);
    try {
      if (await onSave({ branchPrefix: prefix, conventionalCommits: conventional })) {
        onOpenChange(false);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Stack settings</DialogTitle>
          <DialogDescription>
            How this panel names the branches it creates.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="gh-stack-branch-prefix"
              className="text-sm font-medium text-foreground"
            >
              Branch prefix
            </label>
            <Input
              id="gh-stack-branch-prefix"
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder={detectedPrefix ?? "none"}
              className="h-8 font-mono text-sm"
              disabled={saving}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {detectedPrefix
                ? `Leave empty to keep matching this workspace's branches (${detectedPrefix}).`
                : "Leave empty to match whatever namespace this workspace's branches use."}{" "}
              A trailing separator is added when it is missing.
            </p>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <span className="text-sm font-medium text-foreground">
                Conventional Commits
              </span>
              <p className="text-xs text-muted-foreground">
                Titles read <span className="font-mono">feat(scope): …</span>,
                and the type and scope lead the branch slug. Suggest and Auto
                Stack follow the same convention.
              </p>
            </div>
            <div className="pt-0.5">
              <Switch
                checked={conventional}
                onChange={setConventional}
                disabled={saving}
                label="Use Conventional Commits"
              />
            </div>
          </div>

          <div className="rounded-md border border-border bg-muted/40 p-2 text-xs text-muted-foreground">
            <div className="truncate">{exampleTitle}</div>
            <div className="truncate font-mono text-foreground">
              {exampleBranch}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// The merge confirmation: one all-or-nothing `gh stack merge` run that lands
// every unmerged PR in the stack on the trunk, bottom-first. Merging is
// outward-facing and irreversible, so the click that starts it is a dialog
// rather than a button — and the dialog is where the strategy is chosen.
function MergeDialog({
  open,
  onOpenChange,
  count,
  total,
  base,
  topPrNumber,
  unpushedCount,
  onMerge,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Layers this run merges (the ready run from the trunk up) …
  count: number;
  // … out of the layers still unmerged. Equal when the whole stack goes.
  total: number;
  base: string;
  topPrNumber: number | null;
  unpushedCount: number;
  onMerge: (method: MergeMethod) => void;
}) {
  const left = total - count;
  const [method, setMethod] = useState<MergeMethod>("squash");
  // Reopen on the default: a one-off "Rebase" should not become the habit.
  useEffect(() => {
    if (open) setMethod("squash");
  }, [open]);
  const chosen = MERGE_METHODS.find((entry) => entry.value === method);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Merge {left > 0 ? `${count} of ${total}` : count} layer
            {count === 1 && left === 0 ? "" : "s"} into {base}
          </DialogTitle>
          <DialogDescription>
            This submits GitHub's atomic stack merge
            {topPrNumber !== null ? (
              <>
                {" "}
                for <span className="font-mono">#{topPrNumber}</span>
              </>
            ) : null}
            : that pull request and every unmerged one below it, merged
            bottom-first into <span className="font-mono">{base}</span>. The
            merge is all-or-nothing — if any one of them cannot merge, none
            do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {MERGE_METHODS.map((entry) => (
              <Button
                key={entry.value}
                size="sm"
                variant={entry.value === method ? "default" : "outline"}
                aria-pressed={entry.value === method}
                onClick={() => setMethod(entry.value)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{chosen?.effect}.</p>
          {left > 0 ? (
            <p className="text-xs text-muted-foreground">
              The {left} layer{left === 1 ? "" : "s"} above stay open — a layer
              merges only once every layer under it has, and{" "}
              {left === 1 ? "that one is" : "those are"} still in draft or
              without a PR. Run Sync afterwards to restack{" "}
              {left === 1 ? "it" : "them"} onto {base}.
            </p>
          ) : null}
          {unpushedCount > 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {unpushedCount} branch{unpushedCount === 1 ? " has" : "es have"}{" "}
              unpushed commits. Only what is on GitHub gets merged — run Sync
              first to include them.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            If {base} uses a merge queue, the stack is queued instead and the
            queue picks the strategy.
          </p>
        </div>

        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className={MERGE_BUTTON_CLASSES}
            onClick={() => {
              onOpenChange(false);
              onMerge(method);
            }}
          >
            <Icon name="GitMerge" className="size-3.5" />
            Merge {count} layer{count === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Expansion key for the composer row's working-tree files (branch rows use
// their own name).
const PENDING_KEY = "__pending__";

// Cadence of the background cache revalidation while the panel is open.
const POLL_MS = 30_000;

function StackPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [result, setResult] = useState<StackResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // getStack calls in flight — manual and automatic alike; the refresh icon
  // spins while it is non-zero.
  const [inflight, setInflight] = useState(0);
  const [busy, setBusy] = useState<
    | "sync"
    | "submit"
    | "sync-submit"
    | "prune"
    | "merge"
    | "create"
    | "auto"
    | "checkout"
    | null
  >(null);
  const [prBusy, setPrBusy] = useState<number | null>(null);
  // The client half of the draft overlay: the state a pill was clicked into,
  // by PR number. It covers the round trip the server cannot — between the
  // click and the RPC returning, nothing has been announced yet. The server
  // keeps the same overlay afterwards, so entries here retire as soon as a
  // payload agrees.
  const [draftIntents, setDraftIntents] = useState<Map<number, boolean>>(
    new Map(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [actionDetail, setActionDetail] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggleExpanded = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Cached mode paints instantly from the server's per-thread cache (which
  // revalidates itself in the background); fresh mode waits for a recompute —
  // used by the Refresh button and after actions that change the stack.
  const refresh = useCallback(
    (options?: { fresh?: boolean }) => {
      const fresh = options?.fresh === true;
      if (fresh) setRefreshing(true);
      setInflight((count) => count + 1);
      setFetchError(null);
      return rpc
        .call("getStack", fresh ? { threadId, refresh: true } : { threadId })
        // Responses can resolve out of order (an action's fresh refetch racing
        // a signal-triggered cached one); never replace a payload with an
        // older compute. Equal timestamps still apply — a settings save
        // patches the cached payload without bumping fetchedAt.
        .then((next) =>
          setResult((current) =>
            current && current.fetchedAt > next.fetchedAt ? current : next,
          ),
        )
        .catch((error: unknown) => {
          setFetchError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setLoading(false);
          setInflight((count) => count - 1);
          if (fresh) setRefreshing(false);
        });
    },
    [rpc, threadId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Background auto-refresh: each poll serves the cache and, when stale, kicks
  // a server-side recompute whose completion arrives on the realtime channel.
  useEffect(() => {
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // The server announces every fresh compute; refetch (from cache) so this
  // panel updates even when the compute was triggered elsewhere — another
  // panel, an action, or the thread's agent going idle.
  useRealtime(
    "stack-updated",
    useCallback(
      (payload: unknown) => {
        if (
          typeof payload === "object" &&
          payload !== null &&
          (payload as { threadId?: unknown }).threadId === threadId
        ) {
          void refresh();
        }
      },
      [refresh, threadId],
    ),
  );

  // Signals can be missed while the realtime connection is down; reconcile
  // after every reconnect.
  const connection = useRealtimeConnectionState();
  const previousConnection = useRef(connection);
  useEffect(() => {
    if (previousConnection.current === "reconnecting" && connection === "connected") {
      void refresh();
    }
    previousConnection.current = connection;
  }, [connection, refresh]);

  // Retire an optimistic pill state once a payload reports the same thing:
  // the write is visible, so the overlay has nothing left to hide.
  useEffect(() => {
    const branches = result?.stack?.branches;
    if (!branches) return;
    setDraftIntents((current) => {
      if (current.size === 0) return current;
      const next = new Map(current);
      for (const branch of branches) {
        const pr = branch.pr;
        if (pr && next.get(pr.number) === pr.isDraft) next.delete(pr.number);
      }
      return next.size === current.size ? current : next;
    });
  }, [result]);

  const runAction = async (
    action: "sync" | "submit" | "sync-submit" | "prune",
  ) => {
    setBusy(action);
    setActionDetail(null);
    try {
      const outcome = await rpc.call("runAction", { threadId, action });
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
        setActionDetail(outcome.detail);
      }
      // Hold busy until the fresh payload lands: the subtitles and the
      // sync-first routing derive from it, so re-enabling the buttons
      // against the pre-action state would let a click act on stale counts.
      await refresh({ fresh: true });
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  // throughPrNumber pins the merge to the run the dialog offered, so a layer
  // that goes ready between opening it and confirming is not swept in.
  const mergeStack = async (
    method: MergeMethod,
    throughPrNumber: number | null,
  ) => {
    setBusy("merge");
    setActionDetail(null);
    try {
      const outcome = await rpc.call("mergeStack", {
        threadId,
        method,
        ...(throughPrNumber === null ? {} : { throughPrNumber }),
      });
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
        setActionDetail(outcome.detail);
      }
      // Hold busy until the stack reports the merged state, as runAction does.
      await refresh({ fresh: true });
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  // One entry point for both layer modes: init when there is no stack yet,
  // add on top when there is.
  const addLayer = async (
    name: string,
    branch: string,
    mode: "init" | "add",
  ): Promise<boolean> => {
    setBusy("create");
    setActionDetail(null);
    try {
      const outcome = await rpc.call(mode === "init" ? "createStack" : "addBranch", {
        threadId,
        name,
        branch,
      });
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
        setActionDetail(outcome.detail);
      }
      void refresh({ fresh: true });
      return outcome.ok;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const suggestName = async (): Promise<string> => {
    setSuggesting(true);
    toast("Asking the thread's agent for a title — this can take a minute.");
    try {
      const { name } = await rpc.call("suggestStackName", { threadId });
      return name;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
      return "";
    } finally {
      setSuggesting(false);
    }
  };

  const autoStack = async () => {
    setBusy("auto");
    try {
      const outcome = await rpc.call("autoStack", { threadId });
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
        setActionDetail(outcome.detail);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  // Check out a clicked branch in the workspace. Held busy until the fresh
  // payload lands so the highlight moves with the actual current branch.
  const checkout = async (branchName: string) => {
    setBusy("checkout");
    setActionDetail(null);
    try {
      const outcome = await rpc.call("checkoutBranch", {
        threadId,
        branch: branchName,
      });
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
        setActionDetail(outcome.detail);
      }
      await refresh({ fresh: true });
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const forgetDraftIntent = (prNumber: number) => {
    setDraftIntents((current) => {
      if (!current.has(prNumber)) return current;
      const next = new Map(current);
      next.delete(prNumber);
      return next;
    });
  };

  // The pill flips first and the write follows. Success is silent — the pill
  // is the feedback, and a toast for a state already on screen is noise. A
  // failure drops the optimistic value, so the pill snaps back, and says why.
  const toggleDraft = async (pr: NonNullable<StackBranch["pr"]>) => {
    const draft = !pr.isDraft;
    setPrBusy(pr.number);
    setDraftIntents((current) => new Map(current).set(pr.number, draft));
    try {
      const outcome = await rpc.call("setPrDraft", {
        threadId,
        prNumber: pr.number,
        draft,
      });
      if (!outcome.ok) {
        forgetDraftIntent(pr.number);
        toast.error(outcome.message);
        setActionDetail(outcome.detail);
      }
      void refresh({ fresh: true });
    } catch (error: unknown) {
      forgetDraftIntent(pr.number);
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPrBusy(null);
    }
  };

  // Settings ride along on the getStack payload, so adopt the saved values
  // in place rather than paying for a refetch. Returns whether it stuck.
  const saveSettings = async (next: Settings): Promise<boolean> => {
    try {
      const outcome = await rpc.call("saveSettings", next);
      if (!outcome.ok) {
        toast.error(outcome.message ?? "Could not save the settings.");
        return false;
      }
      setResult((current) =>
        current
          ? {
              ...current,
              settings: outcome.settings,
              branchPrefix:
                outcome.settings.branchPrefix || current.detectedBranchPrefix,
            }
          : current,
      );
      toast.success("Stack settings saved.");
      return true;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    }
  };

  // Everything below reads the stack through the draft overlay, so the merge
  // set and the pills agree on which PRs are ready.
  const rawStack = result?.stack ?? null;
  const stack: StackView | null =
    rawStack && draftIntents.size > 0
      ? {
          ...rawStack,
          branches: rawStack.branches.map((branch) => {
            const pr = branch.pr;
            const intent = pr ? draftIntents.get(pr.number) : undefined;
            return pr && intent !== undefined && intent !== pr.isDraft
              ? { ...branch, pr: { ...pr, isDraft: intent } }
              : branch;
          }),
        }
      : rawStack;
  const pending = result?.pending ?? null;
  const base = stack?.trunk ?? result?.defaultBranch ?? null;
  // gh stack orders branches bottom (nearest trunk) → top; render top-first.
  const layers = stack ? [...stack.branches].reverse() : [];
  const anyBusy = busy !== null;
  const notAStack = result?.error?.kind === "not-a-stack";
  // The rail is the whole UI: it composes on any workspace that resolved,
  // whether or not it already holds a stack.
  const showRail = stack !== null || notAStack;
  // Before the first payload lands the popup still has to open onto
  // something; these match the server's own defaults.
  const settings: Settings = result?.settings ?? {
    branchPrefix: DEFAULT_BRANCH_PREFIX,
    conventionalCommits: true,
  };

  // State-driven action row: the tooltips say what each click would do right
  // now, Sync disarms when there is provably nothing to do, and Submit
  // escalates its label to "Sync + Submit" when a restack must come first.
  // Counts exclude merged and queued branches — the ones gh stack skips.
  const activeBranches = stack
    ? stack.branches.filter((branch) => !branch.isMerged && !branch.isQueued)
    : [];
  const mergedCount = stack
    ? stack.branches.filter((branch) => branch.isMerged).length
    : 0;
  const rebaseCount = activeBranches.filter((branch) => branch.needsRebase).length;
  const trunkBehind = stack?.trunkBehind ?? 0;
  const needsRestack = rebaseCount > 0 || trunkBehind > 0;
  const missingPrCount = activeBranches.filter((branch) => !branch.pr).length;
  const unpushedCount = activeBranches.filter(
    (branch) => (branch.aheadOfRemote ?? 0) > 0,
  ).length;
  const updatePrCount = activeBranches.filter(
    (branch) => branch.pr && (branch.aheadOfRemote ?? 0) > 0,
  ).length;
  const behindCount = activeBranches.filter(
    (branch) => (branch.behindRemote ?? 0) > 0,
  ).length;
  // Null probes mean the remote state is unknown (fetch failed, refs
  // missing), not clean — collapsing them to 0 here would disarm Sync in
  // exactly the situations where it is the recovery path.
  const probesUnknown =
    stack !== null &&
    (stack.trunkBehind === null ||
      activeBranches.some(
        (branch) =>
          branch.aheadOfRemote === null || branch.behindRemote === null,
      ));

  const syncParts: string[] = [];
  if (trunkBehind > 0) syncParts.push(`trunk moved (+${trunkBehind})`);
  if (rebaseCount > 0)
    syncParts.push(
      `${rebaseCount} branch${rebaseCount === 1 ? "" : "es"} to restack`,
    );
  if (unpushedCount > 0) syncParts.push(`${unpushedCount} to push`);
  if (behindCount > 0)
    syncParts.push(
      `${behindCount} branch${behindCount === 1 ? "" : "es"} behind origin`,
    );
  // Sync disarms only when the panel affirmatively knows there is nothing to
  // do. An unknown remote state keeps it armed — clicking it is how the
  // state gets resolved (and how a divergence reaches the agent).
  const syncNeeded = syncParts.length > 0 || probesUnknown;
  const syncSubtitle =
    syncParts.length > 0
      ? syncParts.join(" · ")
      : probesUnknown
        ? "remote state unknown"
        : "up to date";

  // A layer's PR targets the branch below it, so a layer can only merge once
  // every layer under it has. The merge set is therefore a run from the trunk
  // up — the longest prefix of unmerged branches whose PRs are out of draft —
  // and it need not reach the top: the layers above simply stay open. Queued
  // branches count as ready; the queue is where gh stack merge already put
  // them.
  const unmergedBranches = stack
    ? stack.branches.filter((branch) => !branch.isMerged)
    : [];
  const mergeCount = unmergedBranches.length;
  const mergeReady: StackBranch[] = [];
  for (const branch of unmergedBranches) {
    if (!branch.pr || branch.pr.isDraft) break;
    mergeReady.push(branch);
  }
  const mergeReadyCount = mergeReady.length;
  const mergePartial = mergeReadyCount > 0 && mergeReadyCount < mergeCount;
  // The PR the run stops at — what the server is asked to merge through.
  const mergeThroughPr = mergeReady[mergeReadyCount - 1]?.pr?.number ?? null;
  const mergeUnpushed = mergeReady.filter(
    (branch) => (branch.aheadOfRemote ?? 0) > 0,
  ).length;
  const mergeBlocked = mergeReadyCount === 0;
  // Nothing can merge only when the bottom layer itself is not ready; naming
  // that one layer is more useful than counting every unready layer above it.
  const mergeBlocker = unmergedBranches[0];
  const mergeSubtitle =
    mergeReadyCount === 0
      ? mergeBlocker?.pr
        ? `#${mergeBlocker.pr.number} is the bottom layer and still a draft — mark it ready first`
        : "the bottom layer has no PR yet — submit first"
      : mergePartial
        ? `squashes the bottom ${mergeReadyCount} of ${mergeCount} PRs onto ${base ?? "the base branch"}; the rest stay open`
        : `squashes ${mergeReadyCount} PR${mergeReadyCount === 1 ? "" : "s"} onto ${base ?? "the base branch"}, one commit per branch`;

  const submitEffect =
    missingPrCount > 0 && updatePrCount > 0
      ? `opens ${missingPrCount} PR${missingPrCount === 1 ? "" : "s"}, updates ${updatePrCount}`
      : missingPrCount > 0
        ? `opens ${missingPrCount} PR${missingPrCount === 1 ? "" : "s"}`
        : updatePrCount > 0
          ? `updates ${updatePrCount} PR${updatePrCount === 1 ? "" : "s"}`
          : "no PR changes";
  // Submit disarms like Sync: only when the panel affirmatively knows the
  // click would change nothing — no PRs to open or update, no restack to run
  // first, and no probe in the unknown state (an unseen push count could
  // still need a submit).
  const submitNeeded =
    missingPrCount > 0 || updatePrCount > 0 || needsRestack || probesUnknown;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
          <span className="truncate">
            {base ? (
              <>
                {stack ? "Stack on" : "New stack on"}{" "}
                <span className="font-mono text-foreground">{base}</span>
              </>
            ) : (
              "Stacked pull requests"
            )}
          </span>
          {/* A bare clickable icon rather than a button: it reads as part of
              the header line, not as a third action next to Sync/Submit. It
              spins for every getStack in flight — the manual click and the
              background polls alike. */}
          <button
            type="button"
            aria-label="Refresh"
            title={
              result
                ? `Refresh — last updated ${new Date(result.fetchedAt).toLocaleTimeString()}`
                : "Refresh"
            }
            onClick={() => void refresh({ fresh: true })}
            disabled={loading || refreshing || anyBusy}
            className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
          >
            <Icon
              name="RotateCcw"
              className={inflight > 0 ? "size-3 animate-spin" : "size-3"}
            />
          </button>
        </div>
        <span title="Stack settings">
          <Button
            size="sm"
            variant="ghost"
            className="w-8 px-0"
            aria-label="Stack settings"
            onClick={() => setSettingsOpen(true)}
          >
            <Icon name="Settings" className="size-4" />
          </Button>
        </span>
      </div>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        detectedPrefix={result?.detectedBranchPrefix ?? null}
        onSave={saveSettings}
      />

      {fetchError ? (
        <p className="text-sm text-destructive">{fetchError}</p>
      ) : null}

      {result?.error ? (
        notAStack ? (
          <p className="text-xs text-muted-foreground">
            This branch is not part of a stack yet. Name the first layer below,
            or run <span className="font-mono">gh stack init &lt;branch&gt;</span>.
          </p>
        ) : (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
            {result.error.message}
          </div>
        )
      ) : null}

      {showRail ? (
        <div className="rounded-lg border border-border bg-card py-2">
          <LayerComposer
            mode={stack ? "add" : "init"}
            busy={busy === "create"}
            suggesting={suggesting}
            autoStacking={busy === "auto"}
            pending={pending}
            prefix={result?.branchPrefix ?? null}
            conventional={settings.conventionalCommits}
            nextNumber={result?.nextPrNumber ?? null}
            expanded={expanded.has(PENDING_KEY)}
            onToggleExpanded={() => toggleExpanded(PENDING_KEY)}
            onSubmit={(name, branch) =>
              addLayer(name, branch, stack ? "add" : "init")
            }
            onSuggest={suggestName}
            onAutoStack={() => void autoStack()}
          />
          {layers.map((branch) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              prBusy={prBusy}
              expanded={expanded.has(branch.name)}
              onToggleExpanded={() => toggleExpanded(branch.name)}
              onToggleDraft={(pr) => void toggleDraft(pr)}
              onCheckout={(branchName) => void checkout(branchName)}
            />
          ))}
          {/* trunk anchor: dot octicon + BranchName chip (2px/6px pad, 6px radius) */}
          <div className="ml-2 grid grid-cols-[16px_1fr] items-center gap-x-2 px-2 py-1.5">
            <span className="text-muted-foreground">
              <Octicon path={OCTICONS.dot} />
            </span>
            <span className="justify-self-start rounded-md bg-blue-500/10 px-1.5 py-0.5 font-mono text-xs leading-[18px] text-muted-foreground">
              {base ?? "trunk"}
            </span>
          </div>
        </div>
      ) : null}

      {stack ? (
        <div className="space-y-2">
          {/* Button drops `title`, so the tooltips ride on wrappers — and a
              wrapper keeps showing its tooltip while the button is disabled,
              which is when "Sync — up to date" explains the most. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Each glyph names the outcome, not the mechanism: Sync moves
                commits both ways (fetch, rebase, push), Submit opens and
                updates pull requests, Merge lands them. Submit keeps its
                glyph when it escalates to Sync + Submit — the PRs are still
                the point. */}
            <span title={`Sync — ${syncSubtitle}`}>
              <Button
                size="sm"
                onClick={() => void runAction("sync")}
                disabled={anyBusy || !syncNeeded}
              >
                <Icon name="ArrowDataTransferVertical" className="size-3.5" />
                {busy === "sync" || busy === "prune" ? "Syncing…" : "Sync"}
              </Button>
            </span>
            <span title={`Submit — ${submitEffect}`}>
              <Button
                size="sm"
                onClick={() =>
                  void runAction(needsRestack ? "sync-submit" : "submit")
                }
                disabled={anyBusy || !submitNeeded}
              >
                <Icon name="GitPullRequestCreate" className="size-3.5" />
                {busy === "submit" || busy === "sync-submit"
                  ? "Submitting…"
                  : needsRestack
                    ? "Sync + Submit"
                    : "Submit"}
              </Button>
            </span>
            {mergeCount > 0 ? (
              <span title={`Merge — ${mergeSubtitle}`}>
                <Button
                  size="sm"
                  className={MERGE_BUTTON_CLASSES}
                  onClick={() => setMergeOpen(true)}
                  disabled={anyBusy || mergeBlocked}
                >
                  <Icon name="GitMerge" className="size-3.5" />
                  {busy === "merge"
                    ? "Merging…"
                    : mergePartial
                      ? `Merge ${mergeReadyCount} of ${mergeCount} layers`
                      : `Merge ${mergeCount} layer${mergeCount === 1 ? "" : "s"}`}
                </Button>
              </span>
            ) : null}
          </div>
          {mergedCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={anyBusy}
              onClick={() => setPruneOpen(true)}
            >
              Delete {mergedCount} merged local branch
              {mergedCount === 1 ? "" : "es"}…
            </Button>
          ) : null}
        </div>
      ) : null}

      <MergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        count={mergeReadyCount}
        total={mergeCount}
        base={base ?? "the base branch"}
        topPrNumber={mergeThroughPr}
        unpushedCount={mergeUnpushed}
        onMerge={(method) => void mergeStack(method, mergeThroughPr)}
      />

      <Dialog open={pruneOpen} onOpenChange={setPruneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete merged branches</DialogTitle>
            <DialogDescription>
              This runs <span className="font-mono">gh stack sync --prune</span>:
              a full sync (fetch, rebase, push), then deletion of the{" "}
              {mergedCount} local branch{mergedCount === 1 ? "" : "es"} whose
              pull request{mergedCount === 1 ? " is" : "s are"} merged. The
              merged PRs and their remote branches stay on GitHub.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPruneOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                setPruneOpen(false);
                void runAction("prune");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {actionDetail ? (
        <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
          {actionDetail}
        </pre>
      ) : null}

      {!loading && !stack && !result?.error && !fetchError ? (
        <p className="text-sm text-muted-foreground">No stack data.</p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "stack",
    title: "Stack",
    icon: "Layers",
    component: StackPanel,
  });
});
