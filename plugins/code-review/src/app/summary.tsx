import {
  Markdown,
  UrlLink,
  experimental_Icon as Icon,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { prSubPath } from "../shared/schema.ts";
import type { Check, PullRequest, ReviewState, StackPr, TimelineItem } from "../shared/schema.ts";
import { ChecksList, useChecks } from "./checks.tsx";
import { FindingsCard, LinkedThreads } from "./bb-review.tsx";
import { PANEL_PATH, plural, shortSha, subject } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { Notice, Section } from "./notice.tsx";
import { Avatar, PrStateBadge, ReviewStateBadge, Timestamp } from "./status.tsx";

const COUNT_WORDS: readonly [Check["state"], string][] = [
  ["failure", "failing"],
  ["pending", "in progress"],
  ["success", "passed"],
  ["cancelled", "cancelled"],
  ["skipped", "skipped"],
  ["neutral", "neutral"],
];

/** "1 failing, 2 in progress, 9 passed": every state present, worst first. */
export function checkCounts(checks: readonly Check[]): string {
  return COUNT_WORDS.flatMap(([state, word]) => {
    const count = checks.filter((check) => check.state === state).length;
    return count > 0 ? [`${count} ${word}`] : [];
  }).join(", ");
}

const REVIEW_VERB: Record<ReviewState, string> = {
  approved: "approved these changes",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "left a review, since dismissed",
  pending: "started a review",
};

/*
 * Narrow, the summary is one column: what the pull request is, the review's
 * findings, who and what it waits on, then the history. Wide, the waiting-on
 * part moves to a side column. While narrow, the main column's wrapper is
 * `display: contents`, so `order` can put the side column between its parts.
 */
export function PrOverview({ pr }: { pr: PullRequest }) {
  const checks = useChecks(pr);
  return (
    <div className="@container/summary">
      {/* GitHub keeps saying CONFLICTING once a pull request is closed or merged. */}
      {pr.state === "open" && pr.mergeable === "conflicting" ? (
        <Notice tone="error" title="Merge conflicts" className="mb-4">
          This branch conflicts with {pr.baseRefName}. Resolve them before it can merge.
        </Notice>
      ) : null}

      <div className="flex flex-col gap-5 @3xl/summary:flex-row @3xl/summary:items-start">
        <div className="contents @3xl/summary:flex @3xl/summary:min-w-0 @3xl/summary:flex-1 @3xl/summary:flex-col @3xl/summary:gap-5">
          <Description pr={pr} />
          <div className="order-2 min-w-0 empty:hidden">
            <FindingsCard pr={pr} />
          </div>
          <section data-cr-section="checks" aria-label="Checks" className="order-3 min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-xs font-medium text-foreground">Checks</h2>
              {checks.data ? (
                <span className="text-[11px] text-muted-foreground">
                  {checkCounts(checks.data.checks)}
                </span>
              ) : null}
            </div>
            <ChecksList pr={pr} compact />
          </section>
          <Activity pr={pr} />
        </div>
        <div className="order-3 flex min-w-0 flex-col gap-5 @3xl/summary:w-64 @3xl/summary:shrink-0">
          <Reviewers pr={pr} />
          <LinkedThreads pr={pr} />
          <Labels pr={pr} />
          <Stack pr={pr} />
        </div>
      </div>
    </div>
  );
}

function Description({ pr }: { pr: PullRequest }) {
  return (
    <Section title="Description" className="order-1">
      <div className="rounded-lg border border-border bg-card px-3.5 py-3">
        {pr.body.trim() ? (
          <Markdown content={pr.body} className="min-w-0 text-xs [overflow-wrap:anywhere]" />
        ) : (
          <p className="text-muted-foreground italic">No description provided.</p>
        )}
      </div>
    </Section>
  );
}

function Reviewers({ pr }: { pr: PullRequest }) {
  return (
    <Section title="Reviewers">
      {pr.reviewers.length === 0 ? (
        <p className="text-muted-foreground">No reviewers yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {pr.reviewers.map((reviewer) => (
            <li key={`${reviewer.kind}:${reviewer.name}`} className="flex items-center gap-1.5">
              <Avatar login={reviewer.name} url={reviewer.avatarUrl} />
              <span className="min-w-0 truncate text-foreground" title={reviewer.name}>
                {reviewer.name}
              </span>
              {reviewer.kind === "team" ? (
                <span className="shrink-0 text-[11px] text-subtle-foreground">team</span>
              ) : null}
              <ReviewStateBadge state={reviewer.state} className="ms-auto" />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Labels({ pr }: { pr: PullRequest }) {
  if (pr.labels.length === 0) return null;
  return (
    <Section title="Labels">
      <ul className="flex flex-wrap gap-1">
        {pr.labels.map((label) => (
          <li
            key={label.name}
            className="inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-[11px]"
          >
            {/* GitHub's own label colour, the one thing that tells labels apart at a glance. */}
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: `#${label.color}` }}
            />
            {label.name}
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** Parent, this pull request, then its children, oldest base first: the order they merge. */
function Stack({ pr }: { pr: PullRequest }) {
  const { parent, children } = pr.stack;
  if (!parent && children.length === 0) return null;
  return (
    <Section title="Stack">
      <ol className="flex flex-col gap-0.5">
        {parent ? <StackRow pr={pr} item={parent} /> : null}
        <li
          aria-current="page"
          className="flex min-w-0 items-center gap-1.5 rounded-md bg-surface-selected px-1.5 py-1"
        >
          <span className="shrink-0 text-muted-foreground tabular-nums">#{pr.ref.number}</span>
          <span className="min-w-0 truncate font-medium">{pr.title}</span>
        </li>
        {children.map((child) => (
          <StackRow key={child.number} pr={pr} item={child} />
        ))}
      </ol>
    </Section>
  );
}

/** A stacked pull request, opened as the account this one is read as. */
function StackRow({ pr, item }: { pr: PullRequest; item: StackPr }) {
  const { owner, repo } = pr.ref;
  const navigate = useBbNavigate();
  return (
    <li>
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() =>
          navigate.toPluginPanel(PANEL_PATH, {
            subPath: prSubPath({ owner, repo, number: item.number }, "summary", pr.account),
          })
        }
      >
        <span className="shrink-0 text-muted-foreground tabular-nums">#{item.number}</span>
        <span className="min-w-0 truncate">{item.title}</span>
        {item.isDraft || item.state !== "open" ? (
          <PrStateBadge state={item.state} isDraft={item.isDraft} className="ms-auto" />
        ) : null}
      </button>
    </li>
  );
}

function Activity({ pr }: { pr: PullRequest }) {
  return (
    <Section title="Activity" className="order-4">
      {pr.timeline.length === 0 ? (
        <p className="text-muted-foreground">No activity yet.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {pr.timeline.map((item) => (
            <li key={item.id} className="min-w-0">
              <TimelineEntry item={item} />
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function When({ at, href }: { at: string; href?: string }) {
  const time = <Timestamp iso={at} />;
  return href ? (
    <UrlLink href={href} className="text-subtle-foreground hover:text-foreground hover:underline">
      {time}
    </UrlLink>
  ) : (
    <span className="text-subtle-foreground">{time}</span>
  );
}

function Who({ login, avatarUrl }: { login: string; avatarUrl: string | null }) {
  return (
    <>
      <Avatar login={login} url={avatarUrl} />
      <span className="font-medium text-foreground">{login}</span>
    </>
  );
}

const GHOST = { login: "ghost", avatarUrl: null };

/** A comment or review is a card with its body. Commits and events are one quiet line each. */
function TimelineEntry({ item }: { item: TimelineItem }) {
  switch (item.kind) {
    case "comment":
      return (
        <article className="rounded-lg border border-border bg-card">
          <header className="flex flex-wrap items-center gap-1.5 border-b border-border-hairline px-3 py-1.5 text-muted-foreground">
            <Who {...(item.author ?? GHOST)} />
            commented
            <span className="ms-auto">
              <When at={item.createdAt} href={item.url} />
            </span>
          </header>
          <Markdown
            content={item.body}
            className="min-w-0 px-3 py-2 text-xs [overflow-wrap:anywhere]"
          />
        </article>
      );
    case "review": {
      const body = item.body.trim();
      return (
        <article className="rounded-lg border border-border bg-card">
          <header
            className={cn(
              "flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-muted-foreground",
              body && "border-b border-border-hairline",
            )}
          >
            <Who {...(item.author ?? GHOST)} />
            {REVIEW_VERB[item.state]}
            {item.commentCount > 0 ? (
              <span className="text-subtle-foreground">
                · {plural(item.commentCount, "comment")}
              </span>
            ) : null}
            <span className="ms-auto flex items-center gap-1.5">
              <ReviewStateBadge state={item.state} />
              <When at={item.createdAt} href={item.url} />
            </span>
          </header>
          {body ? (
            <Markdown
              content={body}
              className="min-w-0 px-3 py-2 text-xs [overflow-wrap:anywhere]"
            />
          ) : null}
        </article>
      );
    }
    case "commit":
      return (
        <CommitLine
          oid={item.oid}
          message={item.message}
          author={item.author?.login ?? null}
          createdAt={item.createdAt}
        />
      );
    case "event":
      return (
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 px-1 text-muted-foreground">
          <Icon name="Circle" className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
          {item.actor ? (
            <span className="font-medium text-foreground">{item.actor.login}</span>
          ) : null}
          {item.text}
          <span className="ms-auto shrink-0">
            <When at={item.createdAt} />
          </span>
        </p>
      );
  }
}

/** One commit as a quiet line: its short sha, first line, author, and when. */
export function CommitLine({
  oid,
  message,
  author,
  createdAt,
}: {
  oid: string;
  message: string;
  author: string | null;
  createdAt: string;
}) {
  return (
    <p className="flex min-w-0 items-center gap-1.5 px-1 text-muted-foreground">
      <Icon name="GitBranch" className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
      <code className="shrink-0 font-mono text-[11px] text-subtle-foreground" translate="no">
        {shortSha(oid)}
      </code>
      <span className="min-w-0 truncate text-foreground" title={message}>
        {subject(message)}
      </span>
      {author ? (
        <span className="max-w-24 shrink-0 truncate text-subtle-foreground">{author}</span>
      ) : null}
      <span className="ms-auto shrink-0">
        <When at={createdAt} />
      </span>
    </p>
  );
}
