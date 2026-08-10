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
// PRs it doubles as the draft⇄ready toggle. A branch with no PR reads
// "Unsubmitted" in the same slot, so the row always carries one status word.
function StatusPill({
  pr,
  busy,
  syncing,
  onToggle,
}: {
  pr: StackBranch["pr"];
  busy: boolean;
  syncing: boolean;
  onToggle: (() => void) | null;
}) {
  let label: string;
  let tone: string;
  if (!pr) {
    label = "Unsubmitted";
    tone = "bg-muted text-muted-foreground";
  } else if (pr.state === "MERGED") {
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
    // A stale value is dimmed and says so, rather than reading as current.
    return (
      <span
        className={pr?.metadataStale ? `${pill} opacity-60` : pill}
        title={
          pr?.metadataStale
            ? "GitHub could not be read; this is the last known state."
            : undefined
        }
      >
        {label}
      </span>
    );
  }
  return (
    // `relative` lifts the toggle above the row-wide checkout overlay, which
    // is absolutely positioned and would otherwise take this click.
    <button
      type="button"
      className={`${pill} relative gap-1 cursor-pointer hover:border-border disabled:opacity-70`}
      disabled={busy}
      title={
        syncing
          ? `${label} — syncing with GitHub`
          : pr?.isDraft
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

// +N −M, in the diff colors. The file names live in the tree below the row,
// so the chip carries the line counts alone. The colors and the 6px gap match
// the file tree's own decorations (see changed-file-tree), so the row total
// and the rows under it read as one set of figures. Nothing may dim this:
// an opacity here would show as a different color from the same token.
const ADDED_COLOR = "var(--diffs-addition-color, #3fb950)";
const DELETED_COLOR = "var(--diffs-deletion-color, #f85149)";

function DeltaChip({ change }: { change: ChangeSet }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-xs leading-4 tabular-nums">
      <span style={{ color: ADDED_COLOR }}>+{change.additions}</span>
      <span style={{ color: DELETED_COLOR }}>−{change.deletions}</span>
    </span>
  );
}

// Branch state, as uppercase chips. Ordered so "unpushed" — the one that
// says something about the diff beside it — ends up next to the counts.
function BranchChips({ branch }: { branch: StackBranch }) {
  const chip =
    "shrink-0 rounded border px-1 text-[10px] font-medium uppercase leading-4 tracking-wide";
  const settled = branch.isMerged || branch.isQueued;
  return (
    <>
      {branch.needsRebase ? (
        <span className={`${chip} border-destructive/50 text-destructive`}>
          needs rebase
        </span>
      ) : null}
      {/* Two different facts share one chip. A pending auto-stash is the
          louder one — those changes come back on checkout — so it wins the
          wording when both hold. */}
      {branch.hasStash || (branch.stashCount ?? 0) > 0 ? (
        <span
          className={`${chip} inline-flex items-center gap-1 border-border text-muted-foreground`}
          title={
            branch.hasStash
              ? "Tracked changes for this layer are stored in a plugin stash and will return when the layer is checked out."
              : `${branch.stashCount} stash ${branch.stashCount === 1 ? "entry was" : "entries were"} made on this branch. Restore them yourself with git stash.`
          }
        >
          <Icon name="Archive" className="size-3" aria-hidden />
          {branch.hasStash
            ? "stashed"
            : branch.stashCount === 1
              ? "1 stash"
              : `${branch.stashCount} stashes`}
        </span>
      ) : null}
      {!settled && (branch.aheadOfRemote === null || branch.behindRemote === null) ? (
        <span className={`${chip} border-border text-muted-foreground`}>
          remote unknown
        </span>
      ) : null}
      {!settled && branch.aheadOfRemote !== null && branch.aheadOfRemote > 0 ? (
        <span
          className={`${chip} border-amber-600/50 text-amber-600 dark:text-amber-400`}
        >
          {branch.aheadOfRemote} unpushed
        </span>
      ) : null}
    </>
  );
}

// Shared rail row: [16px icon column][content], with the connector segment
// running below the icon down to the next row.
function RailRow({
  icon,
  iconTone,
  accent,
  // The row-wide hover wash reads as "this row does something when clicked",
  // so rows that only hold their own controls opt out of it.
  interactive = true,
  children,
}: {
  icon: string;
  iconTone?: string;
  accent?: boolean;
  interactive?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`relative mx-2 rounded-md ${interactive ? "hover:bg-muted/50" : ""}`}
    >
      {accent ? (
        <div
          className="absolute -left-2 top-1 bottom-1 w-1 rounded-md bg-primary"
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

function ChangeTree({
  change,
  className = "mt-1.5",
}: {
  change: ChangeSet;
  className?: string;
}) {
  return (
    <div className={`${className} space-y-1`}>
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
  // This row's own toggle round trip — never another row's, so pills on
  // different PRs stay independently clickable.
  prBusy: boolean;
  prSyncing: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleDraft: (pr: NonNullable<StackBranch["pr"]>) => void;
  onCheckout: (branchName: string) => void;
}) {
  const pr = branch.pr;
  const title = pr?.title ?? branch.name;
  // Toggling draft over an unread PR would send the wrong direction: the
  // shown value is a guess, so the control waits for a real read.
  const canToggle =
    pr !== null && pr.state === "OPEN" && !pr.metadataStale;
  const canExpand = (branch.diff?.files.length ?? 0) > 0;
  const canCheckout = !branch.isCurrent && !checkoutDisabled;
  const icon = branchIcon(branch);
  return (
    <RailRow
      icon={icon.path}
      iconTone={icon.tone}
      // The accent rail alone marks the current layer; a filled row read as
      // a selection state louder than the rest of the panel.
      accent={branch.isCurrent}
      // The row itself is the checkout control, so the wash appears only
      // where that click would do something.
      interactive={canCheckout}
    >
      {/* Clicking anywhere on the row checks the layer out. The controls that
          do something else — the PR link, the draft pill, the diff toggle —
          are positioned above this overlay. */}
      <button
        type="button"
        onClick={() => onCheckout(branch.name)}
        disabled={!canCheckout}
        aria-label={branch.isCurrent ? "Current branch" : `Check out ${branch.name}`}
        className="absolute inset-0 rounded-md enabled:cursor-pointer disabled:cursor-default"
      />
      {/* One row: state, number, title, then the state chips and counts at
          the trailing edge. The branch name no longer has a line of its own,
          so it rides in the row's tooltip. This container stays static so the
          checkout overlay covers it; each control that does something else
          lifts itself above the overlay with `relative`. */}
      <div className="flex items-center gap-2" title={branch.name}>
        {/* Only this pill's own round trip disables it: a toggle is a
            GitHub-side write that never touches the working tree, so it need
            not wait on checkouts, syncs, or any other pill. */}
        <StatusPill
          pr={pr}
          busy={prBusy}
          syncing={prSyncing}
          onToggle={canToggle && pr ? () => onToggleDraft(pr) : null}
        />
        {/* The link sits between the status pill and the number, so the
            row's controls cluster at its head and the title runs clean to
            the counts. `relative` lifts it above the checkout overlay. */}
        {pr ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title={`Open #${pr.number} on GitHub`}
            aria-label={`Open pull request #${pr.number} on GitHub`}
            className="relative inline-flex shrink-0 items-center text-muted-foreground hover:text-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            <Icon name="ExternalLink" className="size-3.5" aria-hidden />
          </a>
        ) : null}
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {pr ? (
            <span className="shrink-0 font-mono text-xs leading-5 text-muted-foreground tabular-nums">
              #{pr.number}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">
            {title}
          </span>
        </span>
        <BranchChips branch={branch} />
        {/* The counts close the row, and double as the file-tree toggle now
            that the row click is checkout. */}
        {branch.diff && canExpand ? (
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} files changed in ${branch.name}`}
            title={expanded ? "Hide changed files" : "Show changed files"}
            className="relative shrink-0 cursor-pointer rounded-sm"
          >
            <DeltaChip change={branch.diff} />
          </button>
        ) : null}
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
// same subline a branch row has — "#N · branch" plus the diff counts, over
// the changed files themselves. The files are the uncommitted ones, since
// `gh stack add` carries the working tree onto the new branch. With a stack
// the row stacks a branch on top (gh stack add); without one it creates the
// stack (gh stack init).
function LayerComposer({
  mode,
  busy,
  disabled,
  suggesting,
  magicking,
  pending,
  prefix,
  conventional,
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
    <RailRow icon={OCTICONS.plus} interactive={false}>
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
                  ? 'e.g. "feat(api): add rate limiting"'
                  : 'e.g. "feat(api): add rate limiter metrics"'
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
          {/* Secondary like Magic Stack beside it and like Sync/Submit below:
              the default variant is bg-foreground, which reads as the panel's
              loudest surface for what is an ordinary action. */}
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            className="h-7"
            disabled={!canSubmit}
          >
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      </form>
      {/* The uncommitted files stay open here — they are what the layer will
          carry, so they read as the row's content rather than a disclosure.
          Their gap to the field matches the field's own gap to the card edge,
          so the field sits in even space. */}
      {pending && pending.files.length > 0 ? (
        <ChangeTree change={pending} className="mt-3.5" />
      ) : null}
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
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 ${
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
  // The conventional example carries a scope, since that is the part the
  // branch slug drops — showing it here makes that visible.
  const exampleTitle = conventional
    ? "feat(api): add rate limiting"
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
                Layer and PR titles read{" "}
                <span className="font-mono">feat(scope): …</span>, with the
                scope optional. The type leads the branch slug; the scope is
                not part of it. Suggest and Magic Stack follow the same
                convention.
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

// Cadence of the background cache revalidation while the panel is open.
const POLL_MS = 30_000;

// Last known header per thread, module-level on purpose: the panel remounts
// on every tab switch and `result` starts null each time, so without this the
// header blanks for the whole first fetch and then reflows the refresh button
// when the text lands. The remembered value paints immediately and the first
// payload corrects it if the stack changed underneath.
const HEADER_MEMORY = new Map<string, { base: string | null; hadStack: boolean }>();

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
  // Per-PR, so draft toggles run concurrently: each pill locks only itself,
  // and only for its own round trip. A scalar here would let a second
  // toggle's cleanup re-enable a pill whose write was still in flight.
  const [prBusy, setPrBusy] = useState<Set<number>>(new Set());
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
  // Only the rows the reader has explicitly toggled. Everything else follows
  // the default below — the checked-out layer opens on its own, since its
  // changes are the ones being worked on.
  const [expansionOverrides, setExpansionOverrides] = useState<
    Map<string, boolean>
  >(new Map());

  const isExpanded = (branch: StackBranch) =>
    expansionOverrides.get(branch.name) ?? branch.isCurrent;

  const toggleExpanded = (branch: StackBranch) => {
    const next = !isExpanded(branch);
    setExpansionOverrides((current) =>
      new Map(current).set(branch.name, next),
    );
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

  // The pill flips first and the write follows; a failure drops the
  // optimistic value so the pill snaps back, and says why. No panel lock and
  // no fresh refetch: the server claims the new state for every payload it
  // serves and reconciles with its own background recompute, so any number
  // of toggles run at once while the sync engine catches up behind them.
  const toggleDraft = async (pr: NonNullable<StackBranch["pr"]>) => {
    const draft = !pr.isDraft;
    const forgetIntent = () =>
      setDraftIntents((current) => {
        const next = new Map(current);
        next.delete(pr.number);
        return next;
      });
    setPrBusy((current) => new Set(current).add(pr.number));
    setDraftIntents((current) => new Map(current).set(pr.number, draft));
    try {
      const outcome = await rpc.call("setPrDraft", {
        threadId,
        prNumber: pr.number,
        draft,
      });
      setActionDetail(outcome.detail);
      if (!outcome.ok) {
        forgetIntent();
        toast.error(outcome.message);
      }
    } catch (error: unknown) {
      forgetIntent();
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPrBusy((current) => {
        const next = new Set(current);
        next.delete(pr.number);
        return next;
      });
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

  // Retire a client intent once a payload agrees with it. The payload runs
  // through the server's own overlay, so agreement means the server has taken
  // the claim over — from here its draftReconciliationPending flag drives the
  // spinner. An entry left behind would spin its pill forever.
  useEffect(() => {
    if (draftIntents.size === 0) return;
    const branches = result?.stack?.branches;
    if (!branches) return;
    setDraftIntents((current) => {
      let changed = false;
      const next = new Map(current);
      for (const branch of branches) {
        const pr = branch.pr;
        if (!pr) continue;
        const intent = next.get(pr.number);
        if (intent !== undefined && pr.isDraft === intent) {
          next.delete(pr.number);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [result, draftIntents]);

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
  // Remember the header once a payload confirms it, and serve the memory
  // only while none has arrived yet (see HEADER_MEMORY).
  const hasStack = stack !== null;
  useEffect(() => {
    if (result !== null) {
      HEADER_MEMORY.set(threadId, { base, hadStack: hasStack });
    }
  }, [result, base, hasStack, threadId]);
  const remembered = result === null ? HEADER_MEMORY.get(threadId) : undefined;
  const headerBase = base ?? remembered?.base ?? null;
  const headerHasStack = hasStack || (remembered?.hadStack ?? false);
  // gh stack orders branches bottom (nearest trunk) → top; render top-first.
  const layers = stack ? [...stack.branches].reverse() : [];
  // Draft toggles deliberately absent: they are GitHub-side writes that
  // reconcile in the background, so they must not lock the panel.
  const anyBusy = busy !== null;
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
          {/* The remembered header covers the gap between mount and first
              payload, so the text is there immediately and the refresh
              button beside it never reflows. The invisible placeholder only
              remains for a thread this panel has never painted before. */}
          <div className="truncate">
            {headerBase ? (
              <>
                {headerHasStack ? "Stack on" : "New stack on"}{" "}
                <span className="font-mono text-foreground">{headerBase}</span>
              </>
            ) : result === null ? (
              <span className="invisible">Stacked pull requests</span>
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
              prBusy={branch.pr ? prBusy.has(branch.pr.number) : false}
              prSyncing={
                branch.draftReconciliationPending === true ||
                (branch.pr ? draftIntents.has(branch.pr.number) : false)
              }
              expanded={isExpanded(branch)}
              onToggleExpanded={() => toggleExpanded(branch)}
              onToggleDraft={(pr) => void toggleDraft(pr)}
              onCheckout={(branch) => void checkout(branch)}
            />
          ))}
          {/* trunk anchor: dot octicon + BranchName chip (2px/6px pad, 6px radius) */}
          <div className="ml-2 grid grid-cols-[16px_1fr] items-center gap-x-2 px-2 py-1.5">
            <span className="text-muted-foreground">
              <Octicon path={OCTICONS.dot} />
            </span>
            <span className="justify-self-start rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs leading-[18px] text-muted-foreground">
              {base ?? "trunk"}
            </span>
          </div>
        </div>
      ) : null}

      {stack ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {/* Secondary, not the default fill: that variant is
                bg-foreground, the brightest surface the theme has, and two of
                them side by side out-shout the stack they act on. Merge keeps
                its own color — it is the irreversible one. */}
            <span className="flex-1 min-w-fit" title={`Sync — ${syncSubtitle}`}>
              <Button
                size="sm"
                variant="secondary"
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
                variant="secondary"
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
    title: "GitHub Stack",
    icon: "Layers",
    component: StackPanel,
  });
});
