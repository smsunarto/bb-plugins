import { useEffect, useMemo, useRef, useState } from "react";
import {
  REVIEW_REQUEST_ATTRIBUTE,
  isPlainClick,
  requestPullRequestReview,
} from "@bb-plugins/review-request";
import {
  UrlLink,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcMutation as useRpcMutation,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import type { Preset, TaskThread } from "../../shared/contract.js";
import {
  SOURCE_CONTROL_PLUGIN_ID,
  mayHaveMoved,
  sourceControlContract,
  threadPullRequest,
  type ThreadPullRequest,
  type ThreadPullRequestInfo,
} from "../../shared/source-control.js";
import { errorMessage } from "../../shared/errors.js";
import { PR_STATE_META, THREAD_STATUS_META, formatRelativeTime, isActiveThread } from "./meta.js";
import { PresetDialog, savePresetDraft } from "../manage/preset-dialog.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import { useTasksRpc } from "../../shell/data.js";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Hint } from "../../components/hint.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const CHECK_TONE: Record<ThreadPullRequestInfo["checks"][number]["id"], string> = {
  failed: "text-destructive",
  running: "text-warning",
  passed: "text-success",
};

function ThreadPullRequestPill({
  threadId,
  status,
}: {
  threadId: string;
  status: ThreadPullRequest;
}) {
  const navigate = useBbNavigate();
  if (status.kind === "pullRequest") {
    const { pullRequest } = status;
    const meta = PR_STATE_META[pullRequest.state];
    const checks = pullRequest.checks.map((check) => check.label).join(", ");
    const summary = `${pullRequest.title} (${meta.label}${checks ? `, checks: ${checks}` : ""})`;
    return (
      <Hint label={summary}>
        <span className="flex shrink-0">
          <UrlLink
            href={pullRequest.url}
            target="_blank"
            rel="noopener noreferrer"
            // A plain click opens the PR's Review beside its thread when Source Control takes the
            // ask; otherwise, and on a modified or middle click, the link goes to GitHub.
            {...{ [REVIEW_REQUEST_ATTRIBUTE]: "" }}
            onClick={(event) => {
              if (!isPlainClick(event)) return;
              if (!requestPullRequestReview({ url: pullRequest.url, threadId, navigating: true }))
                return;
              event.preventDefault();
              navigate.toThread(threadId);
            }}
            aria-label={`Pull request #${pullRequest.number}: ${summary}`}
            className={cn(
              badgeVariants({ variant: "outline" }),
              "gap-1 rounded-full hover:border-input",
            )}
          >
            <Icon name={meta.icon} className={cn("size-3", meta.textClassName)} />#
            {pullRequest.number}
            {pullRequest.checks.map((check) => (
              <span key={check.id} className={cn("font-normal", CHECK_TONE[check.id])}>
                · {check.label}
              </span>
            ))}
          </UrlLink>
        </span>
      </Hint>
    );
  }
  if (status.kind === "unavailable") {
    return (
      <Hint label="Couldn't check this thread's pull request">
        <span className="shrink-0 text-xs text-muted-foreground">PR unavailable</span>
      </Hint>
    );
  }
  return null;
}

// Each thread's pull request from Source Control. Watching a thread's row is
// what makes Source Control read it, and its invalidations keep the pill
// current. A row the read never returned is unavailable once the read fails,
// as when Source Control is disabled.
function useThreadPullRequests(threads: readonly TaskThread[]) {
  const keysId = threads.map((thread) => thread.threadId).join("\n");
  const keys = useMemo(() => (keysId === "" ? [] : keysId.split("\n")), [keysId]);
  const rows = useRpcKeyedQuery({
    contract: sourceControlContract,
    pluginId: SOURCE_CONTROL_PLUGIN_ID,
    method: "statusForThread",
    keys,
  });
  return (threadId: string): ThreadPullRequest => {
    const row = rows.data?.[threadId];
    if (row !== undefined) return threadPullRequest(row);
    return rows.error ? { kind: "unavailable" } : { kind: "pending" };
  };
}

const OPEN_PULL_REQUEST_REFRESH_MS = 60_000;

// Source Control reads a watched row once and keeps it live only while the
// thread's own tab is open, so an open pull request could merge unseen here.
// While this view is visible, ask it to read those threads again each minute
// and when the window regains focus; its invalidations update the pills.
function useRefreshOpenPullRequests(threadIds: readonly string[]) {
  const refresh = useRpcMutation({
    contract: sourceControlContract,
    pluginId: SOURCE_CONTROL_PLUGIN_ID,
    method: "refreshThread",
  });
  const mutate = useRef(refresh.mutate);
  useEffect(() => {
    mutate.current = refresh.mutate;
  });
  const idsKey = threadIds.join("\n");
  useEffect(() => {
    if (idsKey === "") return undefined;
    const ids = idsKey.split("\n");
    const run = () => {
      if (document.hidden) return;
      for (const threadId of ids) {
        mutate.current({ threadId }).catch(() => {
          // The pill keeps its last row; Source Control being away shows on the next read.
        });
      }
    };
    const timer = window.setInterval(run, OPEN_PULL_REQUEST_REFRESH_MS);
    window.addEventListener("focus", run);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", run);
    };
  }, [idsKey]);
}

function ThreadCard({
  thread,
  pullRequest,
  busy,
  onDetach,
}: {
  thread: TaskThread;
  pullRequest: ThreadPullRequest;
  busy: boolean;
  onDetach: () => void;
}) {
  const navigate = useBbNavigate();
  const meta = THREAD_STATUS_META[thread.liveStatus];
  return (
    <div className="mb-2 flex items-center gap-3 rounded-md border border-border bg-card px-3 py-2 shadow-2xs">
      <span
        className={cn("flex shrink-0 items-center gap-1 text-xs font-medium", meta.textClassName)}
      >
        <span aria-hidden className={cn("size-1.5 rounded-full", meta.dotClassName)} />
        {meta.label}
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{thread.title}</div>
        <div className="text-xs text-muted-foreground">
          {thread.presetName} · attached {formatRelativeTime(thread.attachedAt)}
        </div>
      </div>
      <ThreadPullRequestPill threadId={thread.threadId} status={pullRequest} />
      <Button
        variant="link"
        size="sm"
        className="h-auto shrink-0 gap-1 p-0"
        onClick={() => navigate.toThread(thread.threadId)}
      >
        Open thread
        <Icon name="ArrowUpRight" className="size-3" />
      </Button>
      <Hint label="Detach from task">
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Detach ${thread.title}`}
          disabled={busy}
          className="size-5 shrink-0 text-muted-foreground"
          onClick={onDetach}
        >
          <Icon name="X" className="size-3" />
        </Button>
      </Hint>
    </div>
  );
}

const LAST_PRESET_STORAGE_KEY = "bb-tasks:last-dispatch-preset";

function loadLastPresetId(): string | null {
  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPresetId(presetId: string): void {
  try {
    window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, presetId);
  } catch {}
}

interface DispatchControlProps {
  taskId: string;
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  align?: "start" | "end";
  className?: string;
}

export function DispatchControl({
  taskId,
  presets,
  onError,
  align = "end",
  className,
}: DispatchControlProps) {
  const rpc = useRpc<DelegationRpcContract>();
  const tasksRpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(loadLastPresetId);
  const [createDialogKey, setCreateDialogKey] = useState<number | null>(null);

  const dispatch = async (presetId: string) => {
    setDispatching(true);
    try {
      await rpc.call("delegate", { taskId, presetId });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDispatching(false);
    }
  };

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    storeLastPresetId(preset.id);
    void dispatch(preset.id);
  };

  const primarySegment = "bg-primary text-primary-foreground hover:bg-primary/90";

  if (presets !== undefined && presets.length === 0) {
    return (
      <>
        <Button
          size="sm"
          className={cn("h-7 gap-1", primarySegment, className)}
          onClick={() => setCreateDialogKey(Date.now())}
        >
          <Icon name="Plus" className="size-3.5 shrink-0" />
          Add a preset…
        </Button>
        {createDialogKey !== null ? (
          <PresetDialog
            key={createDialogKey}
            open
            onOpenChange={(open) => {
              if (!open) setCreateDialogKey(null);
            }}
            editing={null}
            onSave={(draft) => savePresetDraft(tasksRpc, null, draft)}
          />
        ) : null}
      </>
    );
  }

  const current =
    presets?.find((preset) => preset.id === lastPresetId) ??
    (presets ? [...presets].sort((a, b) => a.name.localeCompare(b.name))[0] : undefined);

  return (
    <>
      <div className={cn("flex min-w-0", className)}>
        <Button
          size="sm"
          disabled={dispatching || !current}
          className={cn("h-7 min-w-0 flex-1 gap-1 rounded-r-none", primarySegment)}
          onClick={() => {
            if (current) pickPreset(current);
          }}
        >
          <span className="truncate">
            {dispatching ? "Dispatching…" : (current?.name ?? "Dispatch")}
          </span>
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={dispatching || !current}>
            <Button
              size="sm"
              aria-label="Choose dispatch preset"
              className={cn(
                "h-7 shrink-0 rounded-l-none border-l border-primary-foreground/25 px-1",
                primarySegment,
              )}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align}>
            <DropdownMenuLabel>Dispatch with preset</DropdownMenuLabel>
            {(presets ?? []).map((preset) => (
              <DropdownMenuItem key={preset.id} onSelect={() => pickPreset(preset)}>
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="text-xs text-muted-foreground">{preset.modelId}</span>
                {preset.id === current?.id ? <Icon name="Check" className="size-3.5" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

interface ThreadsSectionProps {
  threads: TaskThread[];
  onDetach: (thread: TaskThread) => Promise<void>;
  onError: (message: string) => void;
}

export function ThreadsSection({ threads, onDetach, onError }: ThreadsSectionProps) {
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const performDetach = async (thread: TaskThread) => {
    setPending((current) => new Set(current).add(thread.id));
    try {
      await onDetach(thread);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(thread.id);
        return next;
      });
    }
  };

  const activeCount = threads.filter(isActiveThread).length;
  const pullRequestOf = useThreadPullRequests(threads);
  useRefreshOpenPullRequests(
    threads
      .map((thread) => thread.threadId)
      .filter((threadId) => {
        const status = pullRequestOf(threadId);
        return status.kind === "pullRequest" && mayHaveMoved(status);
      }),
  );

  return (
    <section>
      <div className="mb-2 flex items-center gap-2 pt-2 text-xs font-semibold text-muted-foreground">
        Agent threads
        {activeCount > 0 ? <span className="font-normal">{activeCount} working now</span> : null}
      </div>
      {threads.map((thread) => (
        <ThreadCard
          key={thread.id}
          thread={thread}
          pullRequest={pullRequestOf(thread.threadId)}
          busy={pending.has(thread.id)}
          onDetach={() => setConfirm(thread)}
        />
      ))}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        heading="Detach thread?"
        description={
          confirm
            ? `"${confirm.title}" will no longer be listed on this task. The thread itself is not deleted; re-attach it with bb tasks attach.`
            : ""
        }
        confirmLabel="Detach"
        onConfirm={() => {
          if (confirm) void performDetach(confirm);
        }}
      />
    </section>
  );
}
