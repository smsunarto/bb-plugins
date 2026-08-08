// bb-plugin-gh-stack — frontend: a thread panel that visualizes the
// thread's stacked PRs (gh stack) and runs sync / submit / create.
//
// Layout: one rail. Uncommitted work sits at the top, then a composer row
// that stacks a new layer on top (or creates the stack when there is none),
// then the branches top-first, then the trunk anchor. Every row expands into
// its changed-file tree with +/− deltas.
import "./app.css";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  definePluginApp,
  useComposer,
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
      className={`${pill} cursor-pointer hover:border-border disabled:opacity-60`}
      disabled={busy}
      title={pr.isDraft ? "Mark ready for review" : "Convert to draft"}
      onClick={onToggle}
    >
      {busy ? "…" : label}
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

// A row's changed-file tree, plus the caret that toggles it. Returns null
// when the diff could not be computed or is empty.
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
      className="inline-flex items-center gap-1 rounded text-muted-foreground hover:text-foreground"
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

function BranchRow({
  branch,
  prBusy,
  expanded,
  onToggleExpanded,
  onToggleDraft,
}: {
  branch: StackBranch;
  prBusy: number | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onToggleDraft: (pr: NonNullable<StackBranch["pr"]>) => void;
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
      <div className="flex items-start justify-between gap-3">
        {pr ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground hover:underline"
          >
            {title}
          </a>
        ) : (
          <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground">
            {title}
          </span>
        )}
        {pr ? (
          <StatusPill
            pr={pr}
            busy={prBusy === pr.number}
            onToggle={canToggle ? () => onToggleDraft(pr) : null}
          />
        ) : null}
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
        <ChangeDisclosure
          change={branch.diff}
          expanded={expanded}
          onToggle={onToggleExpanded}
          label={`files changed in ${branch.name}`}
        />
      </div>
      {expanded && branch.diff ? <ChangeTree change={branch.diff} /> : null}
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
  const canSubmit = slug.length > 0 && !busy;
  const submitLabel = mode === "init" ? "Create stack" : "Stack";
  const busyLabel = mode === "init" ? "Creating…" : "Stacking…";
  return (
    <RailRow icon={OCTICONS.plus}>
      <form
        // justify-end only bites on a wrapped line, so buttons that do not
        // fit beside the field land right-aligned under it.
        className="flex flex-wrap items-center justify-end gap-2"
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
            narrow panel; the other buttons wrap below it instead. */}
        <div className="relative w-40 min-w-40 flex-1">
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
        {/* One layer at a time is the form; Magic Stack hands the whole
            split to the thread's agent instead. */}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7"
          disabled={busy || magicking}
          onClick={onMagic}
        >
          {magicking ? "Summoning…" : "Magic Stack 🪄"}
        </Button>
        <Button type="submit" size="sm" className="h-7" disabled={!canSubmit}>
          {busy ? busyLabel : submitLabel}
        </Button>
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

// Expansion key for the composer row's working-tree files (branch rows use
// their own name).
const PENDING_KEY = "__pending__";

// Cadence of the background cache revalidation while the panel is open.
const POLL_MS = 30_000;

function StackPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const [result, setResult] = useState<StackResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<
    "sync" | "submit" | "create" | "magic" | null
  >(null);
  const [prBusy, setPrBusy] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
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

  const runAction = async (action: "sync" | "submit") => {
    setBusy(action);
    setActionDetail(null);
    try {
      const outcome = await rpc.call("runAction", { threadId, action });
      setActionDetail(outcome.detail);
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
      }
      void refresh({ fresh: true });
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
      setActionDetail(outcome.detail);
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
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

  const toggleDraft = async (pr: NonNullable<StackBranch["pr"]>) => {
    setPrBusy(pr.number);
    try {
      const outcome = await rpc.call("setPrDraft", {
        threadId,
        prNumber: pr.number,
        draft: !pr.isDraft,
      });
      setActionDetail(outcome.detail);
      if (outcome.ok) {
        toast.success(outcome.message);
      } else {
        toast.error(outcome.message);
      }
      void refresh({ fresh: true });
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setPrBusy(null);
    }
  };

  const askAgent = (instruction: string) => {
    composer.updateText((current) =>
      current.trim().length > 0 ? `${current}\n\n${instruction}` : instruction,
    );
    composer.focus();
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

  const stack = result?.stack ?? null;
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
    branchPrefix: "",
    conventionalCommits: false,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm text-muted-foreground">
          {base ? (
            <>
              {stack ? "Stack on" : "New stack on"}{" "}
              <span className="font-mono text-foreground">{base}</span>
            </>
          ) : (
            "Stacked pull requests"
          )}
        </div>
        <div className="flex items-center gap-2">
          <span
            title={
              result
                ? `Last updated ${new Date(result.fetchedAt).toLocaleTimeString()}`
                : undefined
            }
          >
            <Button
              size="sm"
              variant="outline"
              onClick={() => void refresh({ fresh: true })}
              disabled={loading || refreshing || anyBusy}
            >
              {loading ? "Loading…" : refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </span>
          {/* Button drops `title`, so the tooltip rides on a wrapper — the
              same idiom the Refresh button's timestamp uses. */}
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
              prBusy={prBusy}
              expanded={expanded.has(branch.name)}
              onToggleExpanded={() => toggleExpanded(branch.name)}
              onToggleDraft={(pr) => void toggleDraft(pr)}
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
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void runAction("sync")}
            disabled={anyBusy}
          >
            {busy === "sync" ? "Syncing…" : "Sync"}
          </Button>
          <Button
            size="sm"
            onClick={() => void runAction("submit")}
            disabled={anyBusy}
          >
            {busy === "submit" ? "Submitting…" : "Submit"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={anyBusy}
            onClick={() =>
              askAgent(
                "Sync the stack with `gh stack sync` and report the result.",
              )
            }
          >
            Ask agent to sync
          </Button>
        </div>
      ) : null}

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
