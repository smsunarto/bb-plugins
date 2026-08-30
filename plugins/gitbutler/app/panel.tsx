import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  experimental_Diff as Diff,
  experimental_FileLink as FileLink,
} from "@get-bb/plugin-sdk/app";
import type {
  BranchView,
  CommitIntent,
  HunkRevisionKey,
  RepositorySnapshot,
} from "../shared/view-types.ts";
import { rpc } from "./rpc.ts";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function allBranchNames(repository: RepositorySnapshot): string[] {
  return [
    ...new Set(
      repository.stacks.flatMap((stack) => stack.branches.map((branch) => branch.branchName)),
    ),
  ];
}

function allHunkKeys(repository: RepositorySnapshot): Set<HunkRevisionKey> {
  return new Set(
    repository.worktree.files.flatMap((file) =>
      file.content.kind === "text" ? file.content.hunks.map((hunk) => hunk.revisionKey) : [],
    ),
  );
}

function FileList(props: {
  readonly environmentId: string;
  readonly files: readonly { readonly path: string; readonly kind: string }[];
}): ReactElement | null {
  if (props.files.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {props.files.map((file) => (
        <li key={`${file.kind}:${file.path}`} className="flex items-center gap-2">
          <span className="w-16 shrink-0 capitalize">{file.kind}</span>
          <FileLink
            target={{ kind: "workspace", environmentId: props.environmentId, path: file.path }}
            className="min-w-0 truncate text-foreground underline-offset-2 hover:underline"
          >
            {file.path}
          </FileLink>
        </li>
      ))}
    </ul>
  );
}

function CommitRows(props: {
  readonly title: string;
  readonly commits: BranchView["commits"];
  readonly environmentId: string;
}): ReactElement | null {
  if (props.commits.length === 0) return null;
  return (
    <section className="mt-3">
      <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h4>
      <div className="mt-1 space-y-2">
        {props.commits.map((commit) => (
          <article key={commit.commitId} className="rounded-md border border-border p-2">
            <div className="flex gap-2 text-xs">
              <code className="shrink-0 text-muted-foreground">{commit.commitId.slice(0, 8)}</code>
              <span className="min-w-0 flex-1 text-foreground">{commit.message}</span>
              {commit.conflicted ? <span className="text-destructive">conflicted</span> : null}
            </div>
            <FileList environmentId={props.environmentId} files={commit.files} />
          </article>
        ))}
      </div>
    </section>
  );
}

function RepositoryView(props: {
  readonly repository: RepositorySnapshot;
  readonly selected: ReadonlySet<HunkRevisionKey>;
  readonly onToggle: (key: HunkRevisionKey) => void;
}): ReactElement {
  const { repository } = props;
  return (
    <div className="space-y-5 p-3 pb-64">
      <section aria-label="GitButler stacks">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Applied stacks</h2>
          <span className="text-xs text-muted-foreground">
            {repository.stacks.length} stack{repository.stacks.length === 1 ? "" : "s"}
          </span>
        </div>
        {repository.stacks.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
            No applied GitButler branches.
          </p>
        ) : (
          <div className="space-y-3">
            {repository.stacks.map((stack, stackIndex) => (
              <article key={stack.rowKey} className="rounded-lg border border-border bg-card p-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Stack {stackIndex + 1}
                </h3>
                <FileList environmentId={repository.environmentId} files={stack.assignedFiles} />
                <div className="mt-2 space-y-3">
                  {stack.branches.map((branch) => (
                    <section key={branch.rowKey} className="rounded-md bg-muted/30 p-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm text-foreground">{branch.branchName}</strong>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {branch.status.label}
                        </span>
                        {branch.reviewId === null ? null : (
                          <span className="text-xs text-muted-foreground">{branch.reviewId}</span>
                        )}
                      </div>
                      {branch.ci === null ? null : (
                        <p className="mt-1 text-xs text-muted-foreground">
                          CI: {branch.ci.status} · {branch.ci.conclusion}
                        </p>
                      )}
                      <CommitRows
                        title="Local commits"
                        commits={branch.commits}
                        environmentId={repository.environmentId}
                      />
                      <CommitRows
                        title="Upstream commits"
                        commits={branch.upstreamCommits}
                        environmentId={repository.environmentId}
                      />
                    </section>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section aria-label="GitButler worktree">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-foreground">Worktree</h2>
          <span className="text-xs text-muted-foreground">
            {repository.worktree.hunkCount} selectable hunk
            {repository.worktree.hunkCount === 1 ? "" : "s"}
          </span>
        </div>
        {repository.worktree.files.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-3 text-sm text-muted-foreground">
            Worktree is clean.
          </p>
        ) : (
          <div className="space-y-3">
            {repository.worktree.files.map((file) => (
              <article key={file.path} className="overflow-hidden rounded-lg border border-border">
                <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2 text-sm">
                  <span className="capitalize text-muted-foreground">{file.kind}</span>
                  <FileLink
                    target={{
                      kind: "workspace",
                      environmentId: repository.environmentId,
                      path: file.path,
                    }}
                    className="min-w-0 flex-1 truncate font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    {file.path}
                  </FileLink>
                </div>
                {file.content.kind === "unselectable" ? (
                  <p className="p-3 text-sm text-muted-foreground">
                    This {file.content.reason.replace("-", " ")} cannot be selected.
                  </p>
                ) : (
                  <div className="divide-y divide-border">
                    {file.content.hunks.map((hunk) => (
                      <div key={hunk.revisionKey}>
                        <label className="flex cursor-pointer items-center gap-2 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={props.selected.has(hunk.revisionKey)}
                            onChange={() => props.onToggle(hunk.revisionKey)}
                            aria-label={`Select hunk ${file.path} line ${hunk.newStart}`}
                          />
                          Lines {hunk.newStart}–{hunk.newStart + Math.max(hunk.newLines - 1, 0)}
                        </label>
                        <Diff path={file.path} patch={hunk.patch} view="unified" />
                      </div>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ReadyPanel(props: {
  readonly threadId: string;
  readonly repository: RepositorySnapshot;
  readonly refreshing: boolean;
  readonly refetch: () => Promise<unknown>;
}): ReactElement {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<HunkRevisionKey>>(() => new Set());
  const [targetMode, setTargetMode] = useState<"existing" | "new">("existing");
  const [existingBranch, setExistingBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [uncertainRefresh, setUncertainRefresh] = useState(false);
  const mutation = rpc.commitSelection.useMutation({ retry: false });
  const branches = useMemo(() => allBranchNames(props.repository), [props.repository]);

  useEffect(() => {
    const currentKeys = allHunkKeys(props.repository);
    setSelected((previous) => {
      const next = new Set([...previous].filter((key) => currentKeys.has(key)));
      if (next.size !== previous.size) {
        setNotice("Some selected hunks changed. Review them again.");
      }
      return next;
    });
  }, [props.repository]);

  useEffect(() => {
    if (branches.length === 0) {
      setTargetMode("new");
      setExistingBranch("");
      return;
    }
    setExistingBranch((current) => (branches.includes(current) ? current : (branches[0] ?? "")));
  }, [branches]);

  function toggle(key: HunkRevisionKey): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const targetBranch = targetMode === "existing" ? existingBranch : newBranch.trim();
  const canCommit =
    selected.size > 0 &&
    message.trim().length > 0 &&
    targetBranch.length > 0 &&
    !mutation.isPending &&
    !uncertainRefresh;

  async function commit(): Promise<void> {
    if (!canCommit) return;
    const intent: CommitIntent = {
      message: message.trim(),
      target:
        targetMode === "existing"
          ? { kind: "existing", branchName: existingBranch }
          : { kind: "new", branchName: newBranch.trim() },
      hunkKeys: [...selected],
    };
    try {
      const result = await mutation.mutateAsync({ threadId: props.threadId, intent });
      if (result.repository !== null) {
        queryClient.setQueryData(rpc.repository.queryKey({ threadId: props.threadId }), {
          repository: result.repository,
        });
      }
      if (result.outcome.kind === "committed") {
        setSelected(new Set());
        setMessage("");
        setNotice(
          `Committed ${result.outcome.committedHunkCount} hunk${result.outcome.committedHunkCount === 1 ? "" : "s"} to ${result.outcome.branchName}.`,
        );
      } else {
        setNotice(result.outcome.message);
      }
      if (result.outcome.kind === "uncertain") setUncertainRefresh(true);
      await props.refetch();
    } catch (error) {
      setUncertainRefresh(true);
      setNotice(
        `The commit result is unknown because the request failed: ${errorMessage(error)}. Refresh before retrying.`,
      );
      await props.refetch();
    } finally {
      setUncertainRefresh(false);
    }
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-foreground">GitButler</h1>
          <p className="truncate text-xs text-muted-foreground">
            but {props.repository.gitButlerVersion}
            {props.repository.mergeBase === null
              ? ""
              : ` · base ${props.repository.mergeBase.commitId.slice(0, 8)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void props.refetch()}
          disabled={props.refreshing}
          className="rounded-md border border-border px-2 py-1 text-xs text-foreground disabled:opacity-50"
        >
          {props.refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <RepositoryView repository={props.repository} selected={selected} onToggle={toggle} />
      </div>
      <footer className="absolute inset-x-0 bottom-0 border-t border-border bg-background/95 p-3 shadow-lg backdrop-blur">
        {notice === null ? null : (
          <output className="mb-2 block text-xs text-muted-foreground">{notice}</output>
        )}
        <label className="block text-xs font-medium text-foreground">
          Commit message
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            rows={2}
            className="mt-1 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <fieldset className="mt-2 text-xs">
          <legend className="font-medium text-foreground">Target branch</legend>
          <div className="mt-1 flex gap-3">
            <label>
              <input
                type="radio"
                name="target-mode"
                checked={targetMode === "existing"}
                disabled={branches.length === 0}
                onChange={() => setTargetMode("existing")}
              />{" "}
              Existing
            </label>
            <label>
              <input
                type="radio"
                name="target-mode"
                checked={targetMode === "new"}
                onChange={() => setTargetMode("new")}
              />{" "}
              New branch
            </label>
          </div>
        </fieldset>
        {targetMode === "existing" ? (
          <select
            aria-label="Existing branch"
            value={existingBranch}
            onChange={(event) => setExistingBranch(event.target.value)}
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          >
            {branches.map((branch) => (
              <option key={branch} value={branch}>
                {branch}
              </option>
            ))}
          </select>
        ) : (
          <input
            aria-label="New branch name"
            value={newBranch}
            onChange={(event) => setNewBranch(event.target.value)}
            placeholder="scott/short-description"
            className="mt-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
        )}
        <button
          type="button"
          disabled={!canCommit}
          onClick={() => void commit()}
          className="mt-2 w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {mutation.isPending
            ? "Committing…"
            : `Commit ${selected.size} selected hunk${selected.size === 1 ? "" : "s"}`}
        </button>
      </footer>
    </div>
  );
}

export function GitButlerPanel(props: { readonly threadId: string }): ReactElement {
  const query = rpc.repository.useQuery({ threadId: props.threadId }, { retry: false });
  if (query.isPending) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Finding this thread's GitButler workspace…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">
          Failed to load GitButler: {errorMessage(query.error)}
        </p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="rounded-md border border-border px-3 py-1.5 text-sm"
        >
          Retry
        </button>
      </div>
    );
  }
  if (query.data.repository.kind === "unavailable") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium text-foreground">GitButler is unavailable</p>
        <p className="text-sm text-muted-foreground">{query.data.repository.issue.message}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="rounded-md border border-border px-3 py-1.5 text-sm"
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <ReadyPanel
      threadId={props.threadId}
      repository={query.data.repository.repository}
      refreshing={query.isFetching}
      refetch={query.refetch}
    />
  );
}
