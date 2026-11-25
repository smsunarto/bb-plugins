/**
 * The Conversation tab: the pull request's comments, reviews, commits and
 * events, oldest first. Ported as it is from code-review's Activity timeline
 * (`plugins/code-review/src/app/summary.tsx`: `Activity`, `TimelineEntry`,
 * `CommitLine`, `When`, `Who`, and the avatar, badge and time helpers they
 * use), so it keeps code-review's look. Read on demand while the tab shows.
 */
import {
  UrlLink,
  experimental_Icon as Icon,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useState, type ReactNode } from "react";
import { describeProblem, readAgo, type Problem } from "../../core/change.ts";
import type { ChangeKey } from "../../core/ids.ts";
import type { Description, TimelineItem } from "../../core/items.ts";
import { sourceControlContract } from "../../contract/rpc.ts";
import { PatchesProblem } from "../file-cards.tsx";
import { absoluteTime, cx, plural, shortId } from "../format.ts";
import { Badge, type BadgeProps } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { PrMarkdown } from "../pr-markdown.tsx";
import { GitHubAvatar } from "../review-ui.tsx";
import { useNow } from "./hooks.ts";
import { ReviewScroller } from "./review-bar.tsx";
import { EmptyState } from "../components/ui/empty-state.tsx";

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

type ReviewState = Extract<TimelineItem, { kind: "review" }>["state"];
type Look = { icon: string; variant: NonNullable<BadgeProps["variant"]>; label: string };

const REVIEW_LOOK: Readonly<Record<ReviewState, Look>> = {
  approved: { icon: "Check", variant: "success", label: "Approved" },
  changes_requested: { icon: "AlertCircle", variant: "danger", label: "Changes requested" },
  commented: { icon: "MessageSquare", variant: "outline", label: "Commented" },
  dismissed: { icon: "X", variant: "secondary", label: "Dismissed" },
};

/** One reviewer's review as code-review's outlined chip. */
function ReviewStateBadge({ state }: { state: ReviewState }) {
  const look = REVIEW_LOOK[state];
  return (
    <Badge variant={look.variant} className="h-5 gap-1 rounded-full px-1 py-0 font-medium">
      <Icon name={look.icon} className="size-3" aria-hidden />
      {look.label}
    </Badge>
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
      <GitHubAvatar login={login} url={avatarUrl} />
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
          <header className="flex min-h-8 flex-wrap items-center gap-1 border-b border-solid border-border-hairline px-3 py-1 text-muted-foreground">
            <Who {...(item.author ?? GHOST)} />
            commented
            <span className="ms-auto">
              <When at={item.createdAt} href={item.url} />
            </span>
          </header>
          <PrMarkdown
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
              "flex min-h-8 flex-wrap items-center gap-1 px-3 py-1 text-muted-foreground",
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
            <span className="ms-auto flex items-center gap-1">
              <ReviewStateBadge state={item.state} />
              <When at={item.createdAt} href={item.url} />
            </span>
          </header>
          {body ? (
            <PrMarkdown
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
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-1 px-1 text-muted-foreground">
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
    <p className="m-0 flex min-w-0 items-center gap-1 px-1 text-muted-foreground">
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
        <EmptyState messageClassName="m-0" message="No activity yet." />
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

/** The conversation read, shared by the Conversation tab and the Overview's description. */
function useConversation(changeKey: ChangeKey) {
  return useRpcQuery({
    contract: sourceControlContract,
    method: "changeConversation",
    input: { key: changeKey },
  });
}

/** Why the conversation shown is an earlier read, and how old it is. */
function StaleNote({ stale, readAt }: { stale: Problem; readAt: number }) {
  const now = useNow();
  return (
    <p
      className="m-0 text-[12px] leading-4 text-muted-foreground"
      data-testid="sc-conversation-stale"
    >
      {describeProblem(stale)} {readAgo(readAt, now)}.
    </p>
  );
}

/** The Overview's section label, as guided-view's "Read in this order". */
const SECTION_LABEL =
  "m-0 text-[11px] leading-4 font-normal tracking-[0.06em] text-(--tertiary-foreground) uppercase";

/** Past this many characters a description starts clipped, so the guide stays in view. */
const LONG_DESCRIPTION = 800;

/**
 * shadcn's typography recipe (ui.shadcn.com/docs/components/typography),
 * scaled from its 16px page to this card. bb's Markdown takes only a
 * className and gives each element its own utilities, so these descendant
 * rules out-rank them; its `first:mt-0` and `last:mb-0` still win, which
 * keeps the card's padding even.
 */
const DESCRIPTION_TYPOGRAPHY = [
  "text-[13px] leading-5.5",
  "[&_p]:mb-3",
  "[&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:text-balance",
  "[&_h2]:mt-5 [&_h2]:border-b [&_h2]:border-solid [&_h2]:border-border-hairline [&_h2]:pb-2 [&_h2]:text-base [&_h2]:tracking-tight",
  "[&_h3]:mt-4 [&_h3]:tracking-tight",
  "[&_h4]:text-[13px] [&_h4]:font-semibold",
  "[&_ul]:mb-3 [&_ol]:mb-3 [&_li]:mb-2",
  "[&_blockquote]:my-3 [&_blockquote]:pl-4 [&_blockquote]:italic",
  "[&_a]:font-medium [&_a]:underline-offset-4",
  // Inline code only: a fenced block's code sits inside its <pre>.
  "[&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:font-semibold",
  "[&_th]:font-semibold [&_tbody_tr]:even:bg-muted/50",
].join(" ");

/** The pull request's description as GitHub's opening post: its author, when, and the body. */
function DescriptionCard({ description }: { description: Description }) {
  const body = description.body.trim();
  const long = body.length > LONG_DESCRIPTION;
  const [expanded, setExpanded] = useState(false);
  const clipped = long && !expanded;
  const author = description.author ?? GHOST;
  return (
    <article
      aria-label="Description"
      data-testid="sc-description"
      className="rounded-lg border border-solid border-border bg-card text-[12px] leading-4"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
        <h2 className={SECTION_LABEL}>Description</h2>
        <span className="ms-auto flex min-w-0 items-center gap-1 text-muted-foreground">
          <GitHubAvatar login={author.login} url={author.avatarUrl} className="size-4" />
          <span className="truncate font-medium text-foreground">{author.login}</span>
          <span aria-hidden>·</span>
          <When at={description.createdAt} href={description.url} />
        </span>
      </header>
      {body ? (
        <>
          <div className={cx("relative", clipped && "max-h-64 overflow-hidden")}>
            <div className="px-4 pt-2 pb-3">
              {/* bb widens a table to its nearest clipping ancestor; clipping here keeps it inside the padding. */}
              <PrMarkdown
                content={body}
                className={cx(
                  "min-w-0 overflow-x-clip [overflow-wrap:anywhere]",
                  DESCRIPTION_TYPOGRAPHY,
                )}
              />
            </div>
            {clipped ? (
              <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-card"
              />
            ) : null}
          </div>
          {long ? (
            <div className="border-t border-solid border-border-hairline px-1 py-1">
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded ? "Show less" : "Show full description"}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <EmptyState
          className="mx-4 mt-2 mb-3"
          messageClassName="m-0"
          message="No description provided."
        />
      )}
    </article>
  );
}

/** The Overview's first card: the pull request's description, from the conversation read. */
export function PullRequestDescription({ changeKey }: { changeKey: ChangeKey }) {
  const query = useConversation(changeKey);
  const answer = query.data;
  if (answer === undefined)
    return query.error ? (
      <PatchesProblem text={query.error.message} onRetry={() => void query.refetch()} />
    ) : (
      <div
        aria-busy="true"
        aria-label="Reading the description"
        data-testid="sc-description-loading"
        className="flex flex-col gap-2 rounded-lg border border-solid border-border p-3"
      >
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  if (!answer.ok)
    return (
      <PatchesProblem text={describeProblem(answer.problem)} onRetry={() => void query.refetch()} />
    );
  if (!answer.description) return null;
  return (
    <>
      {answer.stale ? <StaleNote stale={answer.stale} readAt={answer.readAt} /> : null}
      <DescriptionCard description={answer.description} />
    </>
  );
}

// ── The tab ────────────────────────────────────────────────────────────

function Timeline({ changeKey }: { changeKey: ChangeKey }) {
  const query = useConversation(changeKey);
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
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    );
  if (!answer.ok)
    return (
      <PatchesProblem text={describeProblem(answer.problem)} onRetry={() => void query.refetch()} />
    );
  return (
    <>
      {answer.stale ? <StaleNote stale={answer.stale} readAt={answer.readAt} /> : null}
      <Activity items={answer.items} />
    </>
  );
}

export function ConversationView({
  changeKey,
  hasPullRequest,
  lead,
  bar,
}: {
  changeKey: ChangeKey;
  hasPullRequest: boolean;
  /** Drawn above the timeline, inside the scrolling column (the rail on a narrow page). */
  lead?: ReactNode;
  bar?: ReactNode;
}) {
  return (
    <ReviewScroller
      bar={bar}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain"
      contentClassName="flex max-w-3xl min-w-0 flex-col gap-4 px-4 pt-4 text-[12px] leading-4 @3xl:px-6"
    >
      {lead}
      {hasPullRequest ? (
        <Timeline changeKey={changeKey} />
      ) : (
        <EmptyState
          messageClassName="m-0"
          message="This change has no pull request yet. Its conversation starts once it has one."
        />
      )}
    </ReviewScroller>
  );
}
