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
import { deriveBranchName } from "@/lib/branch-name";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type StackResult = Awaited<ReturnType<Rpc["call"]>> extends infer R
  ? Extract<R, { stack: unknown }>
  : never;
type StackView = NonNullable<StackResult["stack"]>;
type StackBranch = StackView["branches"][number];
type ChangeSet = NonNullable<StackResult["pending"]>;
type Settings = StackResult["settings"];
type MergeMethod = "squash" | "merge" | "rebase";
type ActionTone = "success" | "warning" | "error";
type MergeOffer = {
  count: number;
  total: number;
  base: string;
  throughPrNumber: number;
  unpushedCount: number;
};

const MERGE_BUTTON_CLASSES =
  "bg-green-600 text-white hover:bg-green-700 dark:bg-green-700 dark:hover:bg-green-600";
const MERGE_METHODS: { value: MergeMethod; label: string; effect: string }[] = [
  { value: "squash", label: "Squash", effect: "One commit per branch" },
  { value: "merge", label: "Merge commit", effect: "One merge commit per branch" },
  { value: "rebase", label: "Rebase", effect: "Replay every commit" },
];

function showActionToast(outcome: {
  ok: boolean;
  message: string;
  tone?: ActionTone;
}) {
  const tone = outcome.tone ?? (outcome.ok ? "success" : "error");
  if (tone === "warning") toast.warning(outcome.message);
  else if (tone === "success") toast.success(outcome.message);
  else toast.error(outcome.message);
}

// Octicon paths (16×16), extracted from GitHub's stack widget.
const OCTICONS = {
  prDraft:
    "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  merge:
    "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z",
  dot: "M4 8a4 4 0 1 1 8 0 4 4 0 0 1-8 0Zm4-2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z",
  plus: "M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z",
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
  if (pr.state === "CLOSED")
    return { path: OCTICONS.pr, tone: "text-red-600 dark:text-red-400" };
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
  syncing,
  onToggle,
}: {
  pr: NonNullable<StackBranch["pr"]>;
  busy: boolean;
  syncing: boolean;
  onToggle: (() => void) | null;
}) {
  let label: string;
  let tone: string;
  if (pr.state === "MERGED") {
    label = "Merged";
    tone = "bg-purple-600/10 text-purple-600 dark:text-purple-400";
  } else if (pr.state === "CLOSED") {
    label = "Closed";
    tone = "bg-red-600/10 text-red-600 dark:text-red-400";
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
  return (
    <button
      type="button"
      className={`${pill} gap-1 cursor-pointer hover:border-border disabled:opacity-70`}
      disabled={busy}
      title={
        syncing
          ? `${label} — syncing with GitHub`
          : pr.isDraft
            ? "Mark ready for review"
            : "Convert to draft"
      }
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {label}
      {syncing ? <Icon name="Spinner" className="size-3 animate-spin" /> : null}
    </button>
  );
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

// A row's changed-file summary. Returns null when the diff could not be
// computed or is empty.
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
      className="relative inline-flex items-center rounded text-muted-foreground hover:text-foreground"
    >
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

function BranchRow({
  branch,
  checkoutDisabled,
  prBusy,
  prSyncing,
  expanded,
  onToggleExpanded,
  onToggleDraft,
  onCheckout,
}: {
  branch: StackBranch;
  checkoutDisabled: boolean;
  prBusy: number | null;
  prSyncing: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleDraft: (pr: NonNullable<StackBranch["pr"]>) => void;
  onCheckout: (branchName: string) => void;
}) {
  const pr = branch.pr;
  const title = pr?.title ?? branch.name;
  const canToggle = pr !== null && pr.state === "OPEN";
  const canExpand = (branch.diff?.files.length ?? 0) > 0;
  const icon = branchIcon(branch);
  return (
    <RailRow
      icon={icon.path}
      iconTone={icon.tone}
      accent={branch.isCurrent}
      highlighted={branch.isCurrent}
    >
      <button
        type="button"
        onClick={onToggleExpanded}
        disabled={!canExpand}
        aria-expanded={canExpand ? expanded : undefined}
        aria-label={`${expanded ? "Hide" : "Show"} files changed in ${branch.name}`}
        className="absolute inset-0 rounded-md enabled:cursor-pointer disabled:cursor-default"
      />
      <div className="flex items-start justify-between gap-3">
        {pr ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="relative min-w-0 truncate text-sm font-semibold leading-5 text-foreground hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {title}
          </a>
        ) : (
          <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">
            {title}
          </span>
        )}
        <div className="relative flex shrink-0 items-center gap-1">
          {pr ? (
            <StatusPill
              pr={pr}
              busy={checkoutDisabled || prBusy === pr.number}
              syncing={prSyncing}
              onToggle={canToggle ? () => onToggleDraft(pr) : null}
            />
          ) : null}
          <span title={branch.isCurrent ? "Current branch" : `Check out ${branch.name}`}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="size-5 rounded-sm px-0 text-muted-foreground"
              aria-label={branch.isCurrent ? "Current branch" : `Check out ${branch.name}`}
              disabled={branch.isCurrent || checkoutDisabled}
              onClick={() => onCheckout(branch.name)}
            >
              <Icon name="GitBranch" className="size-3.5" />
            </Button>
          </span>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-4 text-muted-foreground">
        <span className="truncate">
          {pr ? `#${pr.number} · ` : ""}
          {branch.name}
          {!pr ? " · no pull request yet" : ""}
        </span>
        {branch.needsRebase ? (
          <span className="rounded border border-destructive/50 px-1 text-[10px] font-medium uppercase tracking-wide text-destructive">
            needs rebase
          </span>
        ) : null}
        {branch.hasStash ? (
          <span
            className="inline-flex items-center gap-1 rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
            title="Tracked changes for this layer are stored in a plugin stash and will return when the layer is checked out."
          >
            <Icon name="Archive" className="size-3" aria-hidden />
            stashed
          </span>
        ) : null}
        {!branch.isMerged && !branch.isQueued && branch.aheadOfRemote !== null && branch.aheadOfRemote > 0 ? (
          <span className="rounded border border-amber-600/50 px-1 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400">
            {branch.aheadOfRemote} unpushed
          </span>
        ) : null}
        {!branch.isMerged && !branch.isQueued && (branch.aheadOfRemote === null || branch.behindRemote === null) ? (
          <span className="rounded border border-border px-1 text-[10px] font-medium uppercase tracking-wide">
            remote unknown
          </span>
        ) : null}
        {branch.diff && canExpand ? <DeltaChip change={branch.diff} /> : null}
      </div>
      {expanded && branch.diff ? (
        <div className="relative">
          <ChangeTree change={branch.diff} />
        </div>
      ) : null}
    </RailRow>
  );
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
  disabled,
  suggesting,
  magicking,
  pending,
  prefix,
  conventional,
  nextNumber,
  expanded,
  onToggleExpanded,
  onSubmit,
  onSuggest,
  onMagic,
}: {
  mode: "init" | "add";
  busy: boolean;
  disabled: boolean;
  suggesting: boolean;
  magicking: boolean;
  pending: ChangeSet | null;
  prefix: string | null;
  conventional: boolean;
  nextNumber: number | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  // Resolves true when the layer was created, so the field can clear.
  onSubmit: (name: string, branch: string) => Promise<boolean>;
  onSuggest: () => Promise<string>;
  onMagic: () => void;
}) {
  const [name, setName] = useState("");
  const slug = deriveBranchName(name, conventional);
  const branch = slug ? `${prefix ?? ""}${slug}` : "";
  const canSubmit = slug.length > 0 && !busy && !disabled;
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
          void onSubmit(name.trim(), branch).then((created) => {
            if (created) setName("");
            return undefined;
          });
        }}
      >
        {/* The field keeps its own width floor so it stays readable in a
            narrow panel. Its high grow factor leaves the actions at their
            content width while all controls fit on one row. */}
        <div className="relative min-w-40 flex-[999_1_10rem]">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={
              conventional
                ? mode === "init"
                  ? 'e.g. "feat: add rate limiting to the API"'
                  : 'e.g. "feat: add metrics for the rate limiter"'
                : mode === "init"
                  ? 'e.g. "Add rate limiting to the API"'
                  : 'e.g. "Add metrics for the rate limiter"'
            }
            // Room for the suggest button plus a gap, so typed text never
            // runs up against it.
            className="h-7 w-full pr-9 text-sm"
            disabled={busy || disabled}
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
              disabled={busy || disabled || suggesting}
              onClick={() => {
                void onSuggest().then((suggested) => {
                  if (suggested) setName(suggested);
                    return undefined;
                });
              }}
            >
              <Icon
                name={suggesting ? "Spinner" : "Sparkles"}
                className={suggesting ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </Button>
          </span>
        </div>
        {/* Keep both actions on the same line. When the group wraps below the
            field, it grows across the row and gives each action half. */}
        <div className="grid flex-[1_1_auto] grid-cols-2 gap-2">
          {/* One layer at a time is the form; Magic Stack hands the whole
              split to the thread's agent instead. */}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7"
            disabled={busy || disabled || magicking}
            onClick={onMagic}
          >
            {magicking ? "Summoning…" : "Magic Stack 🪄"}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="h-7"
            disabled={!canSubmit}
          >
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </form>
      {/* Same subline as a branch row: "#N · branch", then the file count. */}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-4 text-muted-foreground">
        <span className="truncate">
          {nextNumber !== null ? `#${nextNumber} · ` : ""}
          {branch || "working tree"}
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
    ? "feat: add rate limiting to the API"
    : "Add rate limiting to the API";
  const examplePrefix = prefix.trim() || detectedPrefix || "";
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
                Titles read <span className="font-mono">feat: …</span>, and the
                type leads the branch slug. Suggest and Magic Stack follow the
                same convention.
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
  count: number;
  total: number;
  base: string;
  topPrNumber: number;
  unpushedCount: number;
  onMerge: (method: MergeMethod) => void;
}) {
  const [method, setMethod] = useState<MergeMethod>("squash");
  const left = total - count;
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
            {count === 1 ? "" : "s"} into {base}
          </DialogTitle>
          <DialogDescription>
            GitHub will atomically merge PR #{topPrNumber} and every eligible
            PR below it, bottom-to-top. All complete or enqueue together, or
            none do.
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
              The {left} blocked layer{left === 1 ? "" : "s"} above stay open.
              Run Sync afterwards to restack {left === 1 ? "it" : "them"} onto {base}.
            </p>
          ) : null}
          {unpushedCount > 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {unpushedCount} selected branch{unpushedCount === 1 ? " has" : "es have"}
              {" "}unpushed commits. Only the GitHub state will merge; Sync first to include them.
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            If {base} uses a merge queue, this request is queued rather than reported as merged.
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            className={MERGE_BUTTON_CLASSES}
            disabled={count === 0}
            onClick={() => {
              onOpenChange(false);
              onMerge(method);
            }}
          >
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
  const [busy, setBusy] = useState<
    | "sync"
    | "submit"
    | "sync-submit"
    | "prune"
    | "merge"
    | "create"
    | "magic"
    | "checkout"
    | null
  >(null);
  const [prBusy, setPrBusy] = useState<number | null>(null);
  const [draftIntents, setDraftIntents] = useState<Map<number, boolean>>(new Map());
  // Any mutation can succeed before its response or the following refresh is
  // observed. While true, mutation controls stay locked against stale data;
  // a successful fresh getStack is the only thing that clears it.
  const [mutationNeedsRefresh, setMutationNeedsRefresh] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pruneOpen, setPruneOpen] = useState(false);
  const [mergeOffer, setMergeOffer] = useState<MergeOffer | null>(null);
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
  // used by the refresh control and after actions that change the stack.
  const refresh = useCallback(
    (options?: { fresh?: boolean }) => {
      const fresh = options?.fresh === true;
      if (fresh) setRefreshing(true);
      setFetchError(null);
      return rpc
        .call("getStack", fresh ? { threadId, refresh: true } : { threadId })
        // Responses can resolve out of order (an action's fresh refetch racing
        // a signal-triggered cached one); never replace a payload with an
        // older compute. Equal timestamps still apply — a settings save
        // patches the cached payload without bumping fetchedAt.
        .then((next) => {
          setResult((current) =>
            current && current.fetchedAt > next.fetchedAt ? current : next,
          );
          if (fresh) setMutationNeedsRefresh(false);
          return true;
        })
        .catch((error: unknown) => {
          setFetchError(error instanceof Error ? error.message : String(error));
          return false;
        })
        .finally(() => {
          setLoading(false);
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

  useEffect(() => {
    const branches = result?.stack?.branches;
    if (!branches) return;
    setDraftIntents((current) => {
      const next = new Map(current);
      for (const branch of branches) {
        if (
          branch.pr &&
          next.has(branch.pr.number) &&
          branch.draftReconciliationPending !== true
        ) {
          next.delete(branch.pr.number);
        }
      }
      return next.size === current.size ? current : next;
    });
  }, [result]);

  const runAction = async (
    action: "sync" | "submit" | "sync-submit" | "prune",
  ) => {
    setBusy(action);
    setMutationNeedsRefresh(true);
    setActionDetail(null);
    try {
      const outcome = await rpc.call("runAction", { threadId, action });
      setActionDetail(outcome.detail);
      showActionToast(outcome);
      if (action === "prune" && outcome.ok) {
        // The backend verified the deletion. Retire the old offer immediately
        // even if the following transport refresh has to be retried.
        setResult((current) =>
          current?.stack
            ? {
                ...current,
                stack: { ...current.stack, prunableBranchCount: 0 },
              }
            : current,
        );
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh({ fresh: true });
      setBusy(null);
    }
  };

  const mergeStack = async (method: MergeMethod, throughPrNumber: number) => {
    setBusy("merge");
    setMutationNeedsRefresh(true);
    setActionDetail(null);
    try {
      const outcome = await rpc.call("mergeStack", {
        threadId,
        method,
        throughPrNumber,
      });
      setActionDetail(outcome.detail);
      showActionToast(outcome);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh({ fresh: true });
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
    setMutationNeedsRefresh(true);
    setActionDetail(null);
    try {
      const outcome = await rpc.call(mode === "init" ? "createStack" : "addBranch", {
        threadId,
        name,
        branch,
      });
      setActionDetail(outcome.detail);
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
      }
      return outcome.ok;
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      await refresh({ fresh: true });
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

  const magicStack = async () => {
    setBusy("magic");
    try {
      const outcome = await rpc.call("magicStack", { threadId });
      setActionDetail(outcome.detail);
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const checkout = async (branch: string) => {
    setBusy("checkout");
    setMutationNeedsRefresh(true);
    setActionDetail(null);
    try {
      const outcome = await rpc.call("checkoutBranch", { threadId, branch });
      setActionDetail(outcome.detail);
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh({ fresh: true });
      setBusy(null);
    }
  };

  const toggleDraft = async (pr: NonNullable<StackBranch["pr"]>) => {
    const draft = !pr.isDraft;
    setPrBusy(pr.number);
    setMutationNeedsRefresh(true);
    setDraftIntents((current) => new Map(current).set(pr.number, draft));
    try {
      const outcome = await rpc.call("setPrDraft", {
        threadId,
        prNumber: pr.number,
        draft,
      });
      setActionDetail(outcome.detail);
      if (!outcome.ok) {
        setDraftIntents((current) => {
          const next = new Map(current);
          next.delete(pr.number);
          return next;
        });
        toast.error(outcome.message);
      }
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      await refresh({ fresh: true });
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

  const rawStack = result?.stack ?? null;
  const stack: StackView | null = rawStack
    ? {
        ...rawStack,
        branches: rawStack.branches.map((branch) => {
          const intent = branch.pr ? draftIntents.get(branch.pr.number) : undefined;
          return branch.pr && intent !== undefined
            ? Object.assign({}, branch, {
                pr: Object.assign({}, branch.pr, { isDraft: intent }),
              })
            : branch;
        }),
      }
    : null;
  const pending = result?.pending ?? null;
  const base = stack?.trunk ?? result?.defaultBranch ?? null;
  // gh stack orders branches bottom (nearest trunk) → top; render top-first.
  const layers = stack ? [...stack.branches].reverse() : [];
  const anyBusy = busy !== null || prBusy !== null;
  const mutationsDisabled =
    anyBusy || mutationNeedsRefresh || loading || refreshing;
  const notAStack = result?.error?.kind === "not-a-stack";
  // The rail is the whole UI: it composes on any workspace that resolved,
  // whether or not it already holds a stack.
  const showRail = stack !== null || notAStack;
  // Before the first payload lands the popup still has to open onto
  // something; these match the server's own defaults.
  const settings: Settings = result?.settings ?? {
    branchPrefix: "",
    conventionalCommits: false,
  };

  const activeBranches = stack
    ? stack.branches.filter(
        (branch) =>
          !branch.isMerged &&
          !branch.isQueued &&
          branch.pr?.state !== "MERGED" &&
          branch.pr?.state !== "QUEUED",
      )
    : [];
  const rebaseCount = activeBranches.filter((branch) => branch.needsRebase).length;
  const trunkBehind = stack?.trunkBehind;
  const needsRestack = (trunkBehind ?? 0) > 0 || rebaseCount > 0;
  const missingPrCount = activeBranches.filter((branch) => !branch.pr).length;
  const unpushedCount = activeBranches.filter(
    (branch) => branch.aheadOfRemote !== null && branch.aheadOfRemote > 0,
  ).length;
  const updatePrCount = activeBranches.filter(
    (branch) => branch.pr && branch.aheadOfRemote !== null && branch.aheadOfRemote > 0,
  ).length;
  const behindCount = activeBranches.filter(
    (branch) => branch.behindRemote !== null && branch.behindRemote > 0,
  ).length;
  const remoteUnknown =
    stack !== null &&
    (trunkBehind === null ||
      activeBranches.some(
        (branch) => branch.aheadOfRemote === null || branch.behindRemote === null,
      ));
  const syncParts: string[] = [];
  if ((trunkBehind ?? 0) > 0) syncParts.push(`trunk moved (+${trunkBehind})`);
  if (rebaseCount > 0) syncParts.push(`${rebaseCount} branch${rebaseCount === 1 ? "" : "es"} to restack`);
  if (unpushedCount > 0) syncParts.push(`${unpushedCount} to push`);
  if (behindCount > 0) syncParts.push(`${behindCount} branch${behindCount === 1 ? "" : "es"} behind remote`);
  const syncNeeded = syncParts.length > 0 || remoteUnknown;
  const syncSubtitle = syncParts.length > 0
    ? syncParts.join(" · ")
    : remoteUnknown
      ? "remote state unknown"
      : "up to date";
  const knownSubmitEffect =
    missingPrCount > 0 && updatePrCount > 0
      ? `opens ${missingPrCount} PR${missingPrCount === 1 ? "" : "s"}, updates ${updatePrCount}`
      : missingPrCount > 0
        ? `opens ${missingPrCount} PR${missingPrCount === 1 ? "" : "s"}`
        : updatePrCount > 0
          ? `updates ${updatePrCount} PR${updatePrCount === 1 ? "" : "s"}`
          : "no PR changes";
  const submitEffect = remoteUnknown
    ? knownSubmitEffect === "no PR changes"
      ? "PR or restack state unknown"
      : `${knownSubmitEffect} · other remote state unknown`
    : knownSubmitEffect;
  const submitNeeded = missingPrCount > 0 || updatePrCount > 0 || needsRestack || remoteUnknown;
  const prunableCount = stack?.prunableBranchCount;

  const unmergedBranches = stack
    ? stack.branches.filter((branch) => !branch.isMerged && branch.pr?.state !== "MERGED")
    : [];
  const mergeReady: StackBranch[] = [];
  for (const branch of unmergedBranches) {
    const pr = branch.pr;
    if (!pr || pr.isDraft || (pr.state !== "OPEN" && pr.state !== "QUEUED")) break;
    mergeReady.push(branch);
  }
  const mergeCount = unmergedBranches.length;
  const mergeReadyCount = mergeReady.length;
  const mergeThroughPr = mergeReady.at(-1)?.pr?.number ?? null;
  const mergeUnpushed = mergeReady.filter(
    (branch) => branch.aheadOfRemote !== null && branch.aheadOfRemote > 0,
  ).length;
  const blocker = unmergedBranches[mergeReadyCount];
  const mergeSubtitle = mergeReadyCount > 0
    ? `merges the bottom ${mergeReadyCount} of ${mergeCount} ready layer${mergeReadyCount === 1 ? "" : "s"}`
    : blocker?.pr?.state === "CLOSED"
      ? `#${blocker.pr.number} is closed and blocks the stack`
      : blocker?.pr?.isDraft
        ? `#${blocker.pr.number} is a draft and blocks the stack`
        : "the bottom layer has no open PR — submit first";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
          <div className="truncate">
            {base ? (
              <>
                {stack ? "Stack on" : "New stack on"}{" "}
                <span className="font-mono text-foreground">{base}</span>
              </>
            ) : (
              "Stacked pull requests"
            )}
          </div>
          <button
            type="button"
            title={
              result
                ? `Refresh stack · Last updated ${new Date(result.fetchedAt).toLocaleTimeString()}`
                : "Refresh stack"
            }
            aria-label={
              loading ? "Loading stack" : refreshing ? "Refreshing stack" : "Refresh stack"
            }
            onClick={() => void refresh({ fresh: true })}
            disabled={loading || refreshing || anyBusy}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default disabled:opacity-50"
          >
            <Icon
              name="RotateCcw"
              className={`size-3.5 ${loading || refreshing ? "animate-spin" : ""}`}
            />
          </button>
        </div>
        <div className="flex shrink-0 items-center">
          {/* Button drops `title`, so the tooltip rides on a wrapper. */}
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

      {mutationNeedsRefresh && !anyBusy ? (
        <div className="rounded-lg border border-amber-600/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
          The stack changed, but its latest state could not be loaded. Refresh
          before running another action.
        </div>
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

      {result?.checkoutWarning ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {result.checkoutWarning}
        </div>
      ) : null}

      {showRail ? (
        <div className="rounded-lg border border-border bg-card py-2">
          <LayerComposer
            mode={stack ? "add" : "init"}
            busy={busy === "create"}
            disabled={mutationsDisabled}
            suggesting={suggesting}
            magicking={busy === "magic"}
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
            onMagic={() => void magicStack()}
          />
          {layers.map((branch) => (
            <BranchRow
              key={branch.name}
              branch={branch}
              checkoutDisabled={mutationsDisabled}
              prBusy={prBusy}
              prSyncing={
                branch.draftReconciliationPending === true ||
                (branch.pr ? draftIntents.has(branch.pr.number) : false)
              }
              expanded={expanded.has(branch.name)}
              onToggleExpanded={() => toggleExpanded(branch.name)}
              onToggleDraft={(pr) => void toggleDraft(pr)}
              onCheckout={(branch) => void checkout(branch)}
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
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1 min-w-fit" title={`Sync — ${syncSubtitle}`}>
              <Button
                size="sm"
                className="w-full"
                onClick={() => void runAction("sync")}
                disabled={mutationsDisabled || !syncNeeded}
              >
                <Icon
                  name={
                    busy === "sync" || busy === "prune"
                      ? "Spinner"
                      : "ArrowReloadHorizontal"
                  }
                  className={
                    busy === "sync" || busy === "prune" ? "animate-spin" : undefined
                  }
                />
                {busy === "sync" || busy === "prune" ? "Syncing…" : "Sync"}
              </Button>
            </span>
            <span className="flex-1 min-w-fit" title={`Submit — ${submitEffect}`}>
              <Button
                size="sm"
                className="w-full"
                onClick={() => void runAction(needsRestack ? "sync-submit" : "submit")}
                disabled={mutationsDisabled || !submitNeeded}
              >
                <Icon
                  name={
                    busy === "submit" || busy === "sync-submit"
                      ? "Spinner"
                      : "GitPullRequestArrow"
                  }
                  className={
                    busy === "submit" || busy === "sync-submit"
                      ? "animate-spin"
                      : undefined
                  }
                />
                {busy === "submit" || busy === "sync-submit"
                  ? "Submitting…"
                  : needsRestack
                    ? "Sync + Submit"
                    : "Submit"}
              </Button>
            </span>
            {mergeCount > 0 ? (
              <span className="flex-1 min-w-fit" title={`Merge — ${mergeSubtitle}`}>
                <Button
                  size="sm"
                  className={`w-full ${MERGE_BUTTON_CLASSES}`}
                  onClick={() => {
                    if (mergeThroughPr === null) return;
                    setMergeOffer({
                      count: mergeReadyCount,
                      total: mergeCount,
                      base: base ?? "the base branch",
                      throughPrNumber: mergeThroughPr,
                      unpushedCount: mergeUnpushed,
                    });
                  }}
                  disabled={mutationsDisabled || mergeReadyCount === 0}
                >
                  <Icon
                    name={busy === "merge" ? "Spinner" : "GitMerge"}
                    className={busy === "merge" ? "animate-spin" : undefined}
                  />
                  {busy === "merge"
                    ? "Merging…"
                    : mergeReadyCount < mergeCount
                      ? `Merge ${mergeReadyCount} of ${mergeCount} layers`
                      : `Merge ${mergeCount} layer${mergeCount === 1 ? "" : "s"}`}
                </Button>
              </span>
            ) : null}
          </div>
          {prunableCount !== null && prunableCount !== undefined && prunableCount > 0 ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              disabled={mutationsDisabled}
              onClick={() => setPruneOpen(true)}
            >
              Delete {prunableCount} merged local branch{prunableCount === 1 ? "" : "es"}…
            </Button>
          ) : null}
        </div>
      ) : null}

      {mergeOffer ? (
        <MergeDialog
          open
          onOpenChange={(open) => {
            if (!open) setMergeOffer(null);
          }}
          count={mergeOffer.count}
          total={mergeOffer.total}
          base={mergeOffer.base}
          topPrNumber={mergeOffer.throughPrNumber}
          unpushedCount={mergeOffer.unpushedCount}
          onMerge={(method) =>
            void mergeStack(method, mergeOffer.throughPrNumber)
          }
        />
      ) : null}

      <Dialog open={pruneOpen} onOpenChange={setPruneOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete merged local branches</DialogTitle>
            <DialogDescription>
              This runs <span className="font-mono">gh stack sync --prune</span>,
              syncing first and then deleting {prunableCount ?? "the verified"} merged
              local branch{prunableCount === 1 ? "" : "es"}. Remote branches and PRs remain.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button size="sm" variant="outline" onClick={() => setPruneOpen(false)}>
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
