/**
 * The Commits tab: the Change's commits, newest first, drawn as the thread
 * tab's commit rows are. A commit opens to its own files when the Change is
 * read from a checkout; a Change read only from GitHub links to the commit
 * there instead.
 */
import { experimental_useRpcQuery as useRpcQuery } from "@get-bb/plugin-sdk/app";
import { memo, useMemo, type ReactNode } from "react";
import { describeProblem, type Commit } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { ReviewRevision } from "../../core/review.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { FileRowsSkeleton, PatchesProblem } from "../file-cards.tsx";
import { absoluteTime, cx, shortAge, shortId } from "../format.ts";
import { Rail } from "../workspace-lane.tsx";
import { FilesView } from "./files-view.tsx";

/**
 * A commit's own changes as a revision: its parent to itself. The host reads
 * `<id>^` as git does.
 */
export function commitRevision(revision: ReviewRevision, commitId: string): ReviewRevision {
  return { head: commitId, base: `${commitId}^`, source: revision.source };
}

const CommitRow = memo(function CommitRow({
  commit,
  selected,
  last,
  now,
  onSelect,
}: {
  commit: Commit;
  selected: boolean;
  last: boolean;
  now: number;
  onSelect: (commitId: string) => void;
}) {
  const age = commit.createdAt ? shortAge(commit.createdAt, now) : "";
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-testid="sc-commit"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(commit.id)}
        title={commit.subject || "No commit message"}
        className={cx(
          "group relative flex w-full min-w-0 cursor-pointer items-stretch border-0 bg-transparent text-start text-[13px] leading-5 hover:bg-surface-raised focus-visible:-outline-offset-2",
          selected && "bg-surface-raised",
        )}
      >
        {selected ? (
          <span
            aria-hidden
            className="absolute inset-y-1.5 left-0 w-[3px] rounded-r-full bg-(--info)"
          />
        ) : null}
        <Rail tone={commit.conflicted ? "conflicted" : "remote"} diamond={false} />
        <span
          className={cx(
            "flex min-w-0 flex-1 items-center gap-2 py-2 pe-3",
            !last && "border-b border-solid border-border-hairline",
          )}
        >
          <span
            className={cx(
              "min-w-0 flex-1 truncate font-medium text-foreground",
              !commit.subject && "font-normal text-muted-foreground italic",
            )}
          >
            {commit.subject || "No commit message"}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-(--tertiary-foreground)">
            {shortId(commit.id)}
          </span>
          {age ? (
            <time
              dateTime={commit.createdAt ?? undefined}
              title={commit.createdAt ? absoluteTime(commit.createdAt) : undefined}
              className="shrink-0 text-[11px] text-muted-foreground tabular-nums"
            >
              {age}
            </time>
          ) : null}
        </span>
      </button>
    </li>
  );
});

type CommitsAnswer = ReturnType<typeof useCommits>["data"];

function useCommits(changeKey: ChangeKey, revision: ReviewRevision) {
  return useRpcQuery({
    contract: sourceControlContract,
    method: "changeCommits",
    input: { key: changeKey, revision },
  });
}

function CommitList({
  answer,
  error,
  retry,
  selected,
  now,
  onCommit,
}: {
  answer: CommitsAnswer;
  error: string | null;
  retry: () => void;
  selected: string | null;
  now: number;
  onCommit: (commitId: string) => void;
}) {
  if (answer === undefined)
    return error ? (
      <PatchesProblem text={error} onRetry={retry} />
    ) : (
      <FileRowsSkeleton rows={4} label="Loading commits…" />
    );
  if (!answer.ok) return <PatchesProblem text={describeProblem(answer.problem)} onRetry={retry} />;
  if (answer.commits.length === 0)
    return (
      <p className="m-0 px-3 py-3 text-[12px] leading-4 text-muted-foreground">No commits yet.</p>
    );
  return (
    <ul className="m-0 list-none p-0" aria-label="Commits">
      {answer.commits.map((entry, index) => (
        <CommitRow
          key={entry.id}
          commit={entry}
          selected={entry.id === selected}
          last={index === answer.commits.length - 1 && !answer.more}
          now={now}
          onSelect={onCommit}
        />
      ))}
      {answer.more ? (
        <li className="border-t border-solid border-border-hairline ps-10 pe-3 py-2 text-[12px] leading-4 text-muted-foreground">
          Older commits not shown
        </li>
      ) : null}
    </ul>
  );
}

function OnGitHub({ url, commit }: { url: string | null; commit: string }) {
  return (
    <p
      className="m-0 text-[12px] leading-5 text-muted-foreground"
      data-testid="sc-commit-elsewhere"
    >
      bb reads this change from GitHub only, so its commits open there.{" "}
      {url ? (
        <a
          href={`${url}/commits/${commit}`}
          target="_blank"
          rel="noreferrer"
          className="text-foreground underline underline-offset-2"
        >
          Open {shortId(commit)} on GitHub
        </a>
      ) : null}
    </p>
  );
}

export function CommitsView({
  changeKey,
  revision,
  commit,
  path,
  line,
  url,
  now,
  lead,
  wide,
  onCommit,
  onPath,
}: {
  changeKey: ChangeKey;
  revision: ReviewRevision;
  commit: string | null;
  path: string | null;
  line: number | null;
  /** The pull request's page, for a commit bb cannot read from a checkout. */
  url: string | null;
  now: number;
  lead?: ReactNode;
  wide: boolean;
  onCommit: (commitId: string) => void;
  onPath: (path: string) => void;
}) {
  const query = useCommits(changeKey, revision);
  const answer = query.data;
  const commits = answer?.ok ? answer.commits : null;
  const selected = commit && commits?.some((entry) => entry.id === commit) ? commit : null;
  const at = useMemo(
    () => (selected && revision.source.kind === "host" ? commitRevision(revision, selected) : null),
    [revision, selected],
  );

  const list = (
    <CommitList
      answer={answer}
      error={query.error?.message ?? null}
      retry={() => void query.refetch()}
      selected={selected}
      now={now}
      onCommit={onCommit}
    />
  );

  const card = (
    <div className="min-w-0 overflow-hidden rounded-[8px] border border-solid border-border-hairline bg-surface-recessed">
      {list}
    </div>
  );
  const elsewhere = selected && !at ? <OnGitHub url={url} commit={selected} /> : null;

  if (at)
    return (
      <div className={cx("flex min-h-0 min-w-0 flex-1", !wide && "flex-col")}>
        {wide ? (
          <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto overscroll-contain border-e border-solid border-border-hairline p-4">
            {card}
          </aside>
        ) : null}
        <FilesView
          key={at.head}
          changeKey={changeKey}
          revision={at}
          path={path}
          line={line}
          onPath={onPath}
          showTree={false}
          lead={
            wide ? (
              lead
            ) : (
              <>
                {lead}
                {card}
              </>
            )
          }
        />
      </div>
    );
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex max-w-3xl min-w-0 flex-col gap-4 px-4 py-4 @3xl:px-6">
        {lead}
        {card}
        {elsewhere}
      </div>
    </div>
  );
}
