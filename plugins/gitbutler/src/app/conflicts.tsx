import { useRef } from "react";
import type { ReactNode } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import type { Branch, Workspace } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { listNames, useFocusAfter } from "./branch-actions.tsx";
import type { WorkspaceTarget } from "./branch-actions.tsx";
import { rpc } from "./rpc.ts";

/**
 * Everything in the workspace that is conflicted, in one place at the top of
 * the panel, with one button that hands all of it to a subthread. One, not one
 * per branch: resolving a lower commit rebases every commit above it, so two
 * agents resolving side by side would rewrite each other's work.
 */

const ACTION = "h-6 gap-1 px-2 text-xs font-normal";
const POLL_MS = 5_000;

/**
 * Branches holding a conflicted commit, in workspace order. `but push` refuses
 * them, and the branch cards take their push buttons away.
 */
function conflictedBranches(workspace: Workspace) {
  return workspace.stacks
    .flatMap((stack) => stack.branches)
    .filter(
      (branch) =>
        branch.status === "conflicted" || branch.commits.some((commit) => commit.conflicted),
    );
}

/** "a has a conflicted commit", "a has conflicted commits", "a and b have conflicted commits". */
function branchesSentence(branches: readonly Branch[]): ReactNode {
  const commits = branches
    .flatMap((branch) => branch.commits)
    .filter((commit) => commit.conflicted);
  const names = listNames(branches.map((branch) => branch.name));
  if (branches.length > 1) return <>{names} have conflicted commits, which can't be pushed.</>;
  return commits.length === 1 ? (
    <>{names} has a conflicted commit, which can't be pushed.</>
  ) : (
    <>{names} has conflicted commits, which can't be pushed.</>
  );
}

export function Conflicts({
  target,
  workspace,
}: {
  target: WorkspaceTarget;
  workspace: Workspace;
}) {
  const branches = conflictedBranches(workspace);
  const files = workspace.conflictedFiles;
  if (branches.length === 0 && files.length === 0) return null;
  return (
    <section
      aria-label="Conflicts"
      className="rounded-md border border-destructive-text/40 bg-card px-2.5 py-2 leading-normal"
    >
      <p className="flex items-center gap-1.5 font-semibold text-destructive-text">
        <Icon name="AlertTriangle" className="size-3 shrink-0" aria-hidden />
        Conflicts to resolve
      </p>
      {branches.length > 0 ? (
        <p className="mt-1 text-muted-foreground">{branchesSentence(branches)}</p>
      ) : null}
      {/*
       * `but status` lists these apart from the other uncommitted changes, so
       * without this they would drop out of the panel at the moment they need
       * attention.
       */}
      {files.length > 0 ? (
        <>
          <p className="mt-1 text-muted-foreground">
            {files.length === 1
              ? "One file holds conflict markers:"
              : `${files.length} files hold conflict markers:`}
          </p>
          <ul className="list-none font-mono text-[11px] [overflow-wrap:anywhere]">
            {files.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        </>
      ) : null}
      <ResolveConflicts target={target} />
    </section>
  );
}

/**
 * The subthread that resolves this repository's conflicts, whichever thread
 * on the workspace started it, and the button that starts or resumes it.
 */
function useConflictResolution(target: WorkspaceTarget) {
  const resolution = rpc.conflictResolution.useQuery(target, {
    // For as long as there are conflicts to show: the subthread stops, is
    // answered from elsewhere and starts again, or is started by another
    // thread on the same workspace.
    refetchInterval: POLL_MS,
  });
  const mutation = rpc.resolveConflicts.useMutation({
    // The answer names the subthread, so it is shown without reading it back.
    // A read still in flight began before the request and would hide it, so
    // it is dropped. Awaited, so the button gives way to the link in the
    // render the request ends in, and the focus follows.
    onSuccess: async ({ threadId }, input) => {
      const queryKey = rpc.conflictResolution.queryKey(input);
      await pluginQueryClient.cancelQueries({ queryKey });
      pluginQueryClient.setQueryData(queryKey, { subthread: { threadId, running: true } });
    },
  });
  return {
    start: () => mutation.mutate(target),
    pending: mutation.isPending,
    error: mutation.error,
    subthread: resolution.data?.subthread ?? null,
  };
}

function ResolveConflicts({ target }: { target: WorkspaceTarget }) {
  const navigate = useBbNavigate();
  const resolution = useConflictResolution(target);
  const { subthread } = resolution;
  // The resolver's own panel shows the same section, about itself.
  const own = subthread?.threadId === target.threadId;
  const button = useRef<HTMLButtonElement>(null);
  const link = useRef<HTMLButtonElement>(null);
  // The button disables itself while it asks, which drops the focus. It comes
  // back to the button when the request failed, or to the link once there is one.
  useFocusAfter(resolution.pending, () => button.current ?? link.current);
  const status = own
    ? "This thread is resolving the conflicts."
    : subthread?.running
      ? "A subthread is resolving the conflicts."
      : subthread
        ? // It may have asked something, or be from an earlier round of conflicts.
          "The conflict subthread has stopped. It may be waiting on you."
        : "A subthread can resolve them for you.";
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {/* Always mounted, so each change of status is announced. */}
        <output className="me-auto text-muted-foreground">{status}</output>
        {subthread && !own ? (
          <Button
            ref={link}
            variant="ghost"
            size="sm"
            className={ACTION}
            onClick={() => navigate.toThread(subthread.threadId)}
          >
            Open subthread
          </Button>
        ) : null}
        {/*
         * One resolver per repository: while it works there is nothing to
         * start, and once it stops the button sends it the job again rather
         * than starting a second one beside it.
         */}
        {own || subthread?.running ? null : (
          <Button
            ref={button}
            variant="outline"
            size="sm"
            className={ACTION}
            disabled={resolution.pending}
            onClick={resolution.start}
          >
            <Icon
              name={resolution.pending ? "Spinner" : "GitMerge"}
              className={resolution.pending ? "size-3 animate-spin" : "size-3"}
              aria-hidden
            />
            {subthread ? "Continue resolving" : "Resolve conflicts"}
          </Button>
        )}
      </div>
      {resolution.error ? (
        <p role="alert" className="mt-1 text-[11px] text-destructive-text">
          {resolution.error.message}
        </p>
      ) : null}
    </>
  );
}
