import {
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  useRpc,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { RowContextMenu } from "@/components/inbox/row-context-menu";
import { ProviderGlyph, type ProviderGlyphInfo } from "@/components/inbox/provider-glyph";
import { STATUS_SLOT_CLASS, StatusOrTime } from "@/components/inbox/status-slot";
import { threadDisplayTitle } from "@/lib/inbox";
import { resolveSnoozePresets } from "@/lib/lifecycle";
import {
  createInAppBrowserTab,
  isDesktopInAppBrowserAvailable,
  revealInAppBrowserTab,
  shouldDeferToSystemBrowser,
} from "@/lib/open-in-app-browser";
import { prNumberClassName, prNumberLabel } from "@/lib/pr-status";
import type { SidebarPullRequest } from "@/lib/pr-index";
import type { gtdSidebarRpcContract } from "@/server";

/**
 * One thread as a two-line card: title and status, then project, branch and
 * activity. Status stays in the row while section placement answers the larger
 * question: whether the user or the agent can act next.
 *
 * The row is a positioned container with a full-bleed anchor UNDER the
 * controls, the way bb's own thread row does it: a `<button>` inside an `<a>`
 * is invalid interactive nesting and breaks keyboard behaviour.
 */
export function ThreadCard({
  thread,
  provider,
  projectName,
  branchName,
  isActive,
  canPark,
  showProviderIcon,
  onNavigate,
  onSettle,
  onSnooze,
  now,
  debugPullRequests,
  pullRequest,
}: {
  thread: PluginSidebarThread;
  provider?: ProviderGlyphInfo;
  projectName: string | null;
  /** bb's branch, or GitButler's virtual-branch summary for its workspace. */
  branchName: string | null;
  isActive: boolean;
  /** False while the thread is working or blocked on the user. */
  canPark: boolean;
  /** The `showProviderIcon` setting, on by default. */
  showProviderIcon: boolean;
  onNavigate: () => void;
  onSettle: () => void;
  onSnooze: (snoozedUntil: number, pullRequestUrl: string | null) => void;
  /** Quantized clock, so every card in one render agrees on "now". */
  now: number;
  debugPullRequests: boolean;
  pullRequest: SidebarPullRequest | null;
}) {
  const actions = useSidebarThreadActions();
  const rpc = useRpc<typeof gtdSidebarRpcContract>();
  const { splitProps, layout } = useSidebarThreadSplit(thread.id);

  return (
    <RowContextMenu thread={thread}>
      <li className="list-none">
        <div
          className={cn(
            "group/card relative rounded-md px-2.5 py-1.5 transition-colors",
            isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
            // A thread open in another pane gets a weaker tint than the active
            // row, so the two states stay distinguishable.
            !isActive && layout !== null && "bg-sidebar-accent/30",
          )}
        >
          {/* oxlint-disable-next-line jsx-a11y/anchor-is-valid -- must stay an
              anchor: the shortcut-target contract below and modifier-click
              split-open both depend on it. A button breaks each. */}
          <a
            // Both attributes, or bb's nine thread shortcuts stop finding rows.
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={threadDisplayTitle(thread)}
            {...splitProps}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              actions.open(thread.id, {
                split: event.metaKey || event.ctrlKey,
              });
              onNavigate();
            }}
            className="absolute inset-0 cursor-pointer rounded-md"
          />
          <div className="pointer-events-none relative flex h-5 items-center gap-1.5">
            <span
              className={cn(
                // Keep resting titles on the sidebar's own text ladder. The
                // active row earns the brighter accent foreground, while weight
                // alone still carries unread.
                "min-w-0 flex-1 truncate text-sm",
                isActive ? "text-sidebar-accent-foreground" : "text-sidebar-foreground",
                thread.isUnread && "font-medium",
              )}
            >
              {threadDisplayTitle(thread)}
            </span>
            {/* Status at rest, park actions on hover. Only the status yields,
                so the title never shifts. */}
            {canPark ? (
              <span className="pointer-events-auto hidden items-center gap-0.5 group-hover/card:flex">
                <ParkButton
                  label="Snooze until tomorrow"
                  icon="Clock"
                  onActivate={() => {
                    // By id, never by index: "This evening" drops out of the
                    // list once 18:00 is under an hour away, so a positional
                    // pick silently becomes "Next week" every afternoon.
                    const presets = resolveSnoozePresets(new Date());
                    const tomorrow = presets.find((p) => p.id === "tomorrow");
                    if (tomorrow) onSnooze(tomorrow.snoozedUntil, pullRequest?.url ?? null);
                  }}
                />
                <ParkButton label="Settle thread" icon="Check" onActivate={onSettle} />
              </span>
            ) : null}
            <span className={cn(STATUS_SLOT_CLASS, canPark && "group-hover/card:hidden")}>
              <StatusOrTime thread={thread} now={now} />
            </span>
          </div>
          {/* One step below the title, not half a step: at 10px the size drop
              alone does not carry the hierarchy, so the line also starts at the
              tint the provider glyph already uses. Segments that rank below the
              project dim further from here. */}
          <div className="pointer-events-none relative mt-1 flex h-4 items-center gap-1.5 text-2xs text-muted-foreground/70">
            {/* Project and origin share this line now that the title has taken
                the one above. The project holds its full name and the origin
                yields: which repository a thread belongs to outranks which
                branch it sits on, and the branch is the one that grows without
                bound. The wrapper is the flexible cell either way, so a card
                missing both still holds the line's right side still. */}
            <span className="flex min-w-0 flex-1 items-center gap-1">
              {projectName ? <span className="min-w-0 truncate">{projectName}</span> : null}
              {projectName && (branchName || thread.host) ? (
                <span aria-hidden className="shrink-0 text-muted-foreground/40">
                  ·
                </span>
              ) : null}
              {/* Weighted rather than capped, so the project keeps its full
                  name whenever the line has room for both and only starts
                  truncating once this one has already given up everything. A
                  fixed cap on the project instead truncates it while slack
                  sits unused beside a short branch. Never `flex-1` either: a
                  branch that GREW would take that slack off the project.
                  Overflowing beyond zero is left alone — the project is
                  truncating by then, so this segment has nothing to show.

                  A thread without a worktree still runs somewhere, so the
                  machine takes the branch's place rather than leaving the
                  segment blank. */}
              {branchName ? (
                <span className="min-w-0 shrink-[9999] truncate font-mono text-muted-foreground/50">
                  {branchName}
                </span>
              ) : thread.host ? (
                <span className="min-w-0 shrink-[9999] truncate text-muted-foreground/50">
                  {thread.host.name}
                </span>
              ) : null}
            </span>
            {thread.activity.workflows > 0 ? (
              <ActivityCount label="workflows" count={thread.activity.workflows} />
            ) : null}
            {thread.activity.backgroundAgents > 0 ? (
              <ActivityCount label="background agents" count={thread.activity.backgroundAgents} />
            ) : null}
            {pullRequest ? (
              <a
                href={pullRequest.url}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  event.stopPropagation();
                  if (
                    shouldDeferToSystemBrowser(event) ||
                    !isDesktopInAppBrowserAvailable()
                  ) {
                    return;
                  }
                  event.preventDefault();
                  const tab = createInAppBrowserTab({
                    environmentId: thread.environment?.id ?? null,
                    title: pullRequest.title,
                    url: pullRequest.url,
                  });
                  revealInAppBrowserTab({ tab, threadId: thread.id });
                  void rpc
                    .call("openThreadBrowserTab", { tab, threadId: thread.id })
                    .then((result) => {
                      if (result.tab.id !== tab.id) {
                        revealInAppBrowserTab({ tab: result.tab, threadId: thread.id });
                      }
                    })
                    .catch(() => {
                      // The local reveal still stands. A failed persist must
                      // not bounce the click out to the system browser.
                    });
                  actions.open(thread.id);
                }}
                title={`${prNumberLabel(pullRequest)}: ${pullRequest.title}`}
                className={cn(
                  "pointer-events-auto relative shrink-0 font-mono hover:underline",
                  prNumberClassName(pullRequest),
                )}
              >
                #{pullRequest.number}
                {debugPullRequests ? (
                  <span className="text-muted-foreground/70">·{pullRequest.source}</span>
                ) : null}
              </a>
            ) : null}
            {/* Drawn for every card or for none, never per thread, so the line
                keeps a fixed right edge whichever way the setting is set. */}
            {showProviderIcon ? (
              <ProviderGlyph providerId={thread.providerId} provider={provider} />
            ) : null}
          </div>
        </div>
      </li>
    </RowContextMenu>
  );
}

function ParkButton({
  label,
  icon,
  onActivate,
}: {
  label: string;
  icon: Extract<IconName, "Clock" | "Check">;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      className="rounded p-0.5 text-muted-foreground hover:text-foreground"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function ActivityCount({ label, count }: { label: string; count: number }) {
  return (
    <span
      aria-label={`${count} ${label}`}
      className="shrink-0 rounded bg-muted px-1 font-mono text-2xs text-muted-foreground/70"
    >
      {count}
    </span>
  );
}
