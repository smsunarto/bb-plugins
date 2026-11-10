/**
 * The Conversation tab: the pull request's comments, reviews, commits and
 * events, oldest first. Ported as it is from code-review's Activity timeline
 * (`plugins/code-review/src/app/summary.tsx`: `Activity`, `TimelineEntry`,
 * `CommitLine`, `When`, `Who`, and the avatar, badge and time helpers they
 * use), so it keeps code-review's look. Read on demand while the tab shows.
 */
import {
  Markdown,
  UrlLink,
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import type { ReactNode } from "react";
import { describeProblem } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { TimelineItem } from "../../core/items.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { PatchesProblem } from "../file-cards.tsx";
import { absoluteTime, cx, plural, shortId } from "../format.ts";
import { Bar } from "../ui.tsx";

// ── code-review's helpers ──────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "5m ago", "3h ago", "2d ago", then a short date. Empty for an unreadable value. */
export function relativeTime(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const elapsed = now - timestamp;
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A commit message's first line. */
export function subject(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/** How long ago, with the full date and time on hover. */
function Timestamp({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

function Avatar({ login, url }: { login: string; url: string | null }): ReactNode {
  const box = "size-4 shrink-0 rounded-full bg-secondary";
  if (!url)
    return (
      <span
        aria-hidden
        className={cx(box, "inline-flex items-center justify-center text-[9px] uppercase")}
      >
        {login.charAt(0)}
      </span>
    );
  return <img src={url} alt="" className={box} loading="lazy" />;
}

type ReviewState = Extract<TimelineItem, { kind: "review" }>["state"];
type Look = { icon: string; tone: string; label: string };

const REVIEW_LOOK: Readonly<Record<ReviewState, Look>> = {
  approved: { icon: "Check", tone: "text-success", label: "Approved" },
  changes_requested: {
    icon: "AlertCircle",
    tone: "text-destructive-text",
    label: "Changes requested",
  },
  commented: { icon: "MessageSquare", tone: "text-muted-foreground", label: "Commented" },
  dismissed: { icon: "X", tone: "text-subtle-foreground", label: "Dismissed" },
};

/** One reviewer's review as code-review's outlined chip. */
function ReviewStateBadge({ state }: { state: ReviewState }) {
  const look = REVIEW_LOOK[state];
  return (
    <span
      className={cx(
        "inline-flex h-4.5 shrink-0 items-center gap-1 rounded-full px-1.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-current/30 ring-inset",
        look.tone,
      )}
    >
      <Icon name={look.icon} className="size-3" aria-hidden />
      {look.label}
    </span>
  );
}

const REVIEW_VERB: Record<ReviewState, string> = {
  approved: "approved these changes",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "left a review, since dismissed",
};

// ── The timeline ───────────────────────────────────────────────────────

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
        <article className="rounded-lg border border-solid border-border bg-card">
          <header className="flex flex-wrap items-center gap-1.5 border-b border-solid border-border-hairline px-3 py-1.5 text-muted-foreground">
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
        <article className="rounded-lg border border-solid border-border bg-card">
          <header
            className={cx(
              "flex flex-wrap items-center gap-1.5 px-3 py-1.5 text-muted-foreground",
              body && "border-b border-solid border-border-hairline",
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
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-1.5 px-1 text-muted-foreground">
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
    <p className="m-0 flex min-w-0 items-center gap-1.5 px-1 text-muted-foreground">
      <Icon name="GitBranch" className="size-3 shrink-0 text-subtle-foreground" aria-hidden />
      <code className="shrink-0 font-mono text-[11px] text-subtle-foreground" translate="no">
        {shortId(oid)}
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

function Activity({ items }: { items: readonly TimelineItem[] }) {
  return (
    <section aria-labelledby="sc-activity" className="min-w-0" data-testid="sc-conversation">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id="sc-activity" className="m-0 text-xs font-semibold text-foreground">
          Activity
        </h2>
      </div>
      {items.length === 0 ? (
        <p className="m-0 text-muted-foreground">No activity yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item) => (
            <li key={item.id} className="min-w-0">
              <TimelineEntry item={item} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ── The tab ────────────────────────────────────────────────────────────

function Timeline({ changeKey }: { changeKey: ChangeKey }) {
  const query = useRpcQuery({
    contract: sourceControlContract,
    method: "changeConversation",
    input: { key: changeKey },
  });
  const answer = query.data;
  if (answer === undefined)
    return query.error ? (
      <PatchesProblem text={query.error.message} onRetry={() => void query.refetch()} />
    ) : (
      <div
        aria-busy="true"
        aria-label="Reading the conversation"
        data-testid="sc-conversation-loading"
        className="flex flex-col gap-2"
      >
        <Bar className="h-3 w-16" />
        <Bar className="h-20 w-full rounded-lg" />
        <Bar className="h-3 w-2/3" />
        <Bar className="h-20 w-full rounded-lg" />
      </div>
    );
  if (!answer.ok)
    return (
      <PatchesProblem text={describeProblem(answer.problem)} onRetry={() => void query.refetch()} />
    );
  return <Activity items={answer.items} />;
}

export function ConversationView({
  changeKey,
  hasPullRequest,
  lead,
}: {
  changeKey: ChangeKey;
  hasPullRequest: boolean;
  /** Drawn above the timeline, inside the scrolling column (the rail on a narrow page). */
  lead?: ReactNode;
}) {
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="flex max-w-3xl min-w-0 flex-col gap-4 px-4 py-4 text-[12px] leading-4 @3xl:px-6">
        {lead}
        {hasPullRequest ? (
          <Timeline changeKey={changeKey} />
        ) : (
          <p className="m-0 text-[13px] leading-5 text-muted-foreground">
            This change has no pull request yet. Its conversation starts once it has one.
          </p>
        )}
      </div>
    </div>
  );
}
