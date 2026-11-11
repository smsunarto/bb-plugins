/**
 * Cards agents wrote before the cutover, `::code-review{pr="owner/repo#12"}`,
 * `::code-review{branch="<id>" base="…" head="…"}` and
 * `::code-review{targets="<encoded JSON list of those>"}`, drawn as Source
 * Control cards. Each target resolves to its Change on the server; one that no
 * longer resolves says why instead of guessing. Registered only from the
 * cutover on: while code-review runs it draws these itself.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  UrlLink,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import { parsePrReference, prKey } from "../core/watch.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ChangeCard } from "./chat-card.tsx";

export const LEGACY_REVIEW_DIRECTIVE = "code-review";

const BRANCH_ID = /^[0-9a-f]{12}$/;
const HEAD = /^[0-9a-f]{4,64}$/i;

type Target = { lookup: string; label: string; head: string | null; url: string | null };

function target(raw: Record<string, unknown>): Target | null {
  if (typeof raw.pr === "string") {
    const ref = /^[^/]+\/[^#]+#\d+$/.test(raw.pr) ? parsePrReference(raw.pr) : null;
    if (!ref) return null;
    return {
      lookup: `pr:${prKey(ref).toLowerCase()}`,
      label: prKey(ref),
      head: null,
      url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    };
  }
  if (typeof raw.branch === "string" && BRANCH_ID.test(raw.branch)) {
    const head = typeof raw.head === "string" && HEAD.test(raw.head) ? raw.head : null;
    return { lookup: `branch:${raw.branch}`, label: "a local branch", head, url: null };
  }
  return null;
}

/** The card's targets from its untrusted attributes; null when they name none. */
export function legacyTargets(
  attributes: Readonly<Record<string, string | undefined>>,
): Target[] | null {
  if (attributes.targets !== undefined) {
    let list: unknown;
    try {
      list = JSON.parse(decodeURIComponent(attributes.targets));
    } catch {
      return null;
    }
    if (!Array.isArray(list) || list.length === 0 || list.length > 25) return null;
    const targets = list.map((each) =>
      typeof each === "object" && each !== null ? target(each as Record<string, unknown>) : null,
    );
    return targets.every((each) => each !== null) ? (targets as Target[]) : null;
  }
  const one = target(attributes);
  return one ? [one] : null;
}

export function LegacyReviewDirective({
  attributes,
  source,
  message,
}: PluginMessageDirectiveProps) {
  const targets = useMemo(() => legacyTargets(attributes), [attributes]);
  if (!targets)
    return (
      <code data-bb-plugin="source-control" data-testid="sc-legacy-invalid">
        {source}
      </code>
    );
  return <LegacyCards targets={targets} threadId={message.threadId} />;
}

function LegacyCards({ targets, threadId }: { targets: Target[]; threadId: string }) {
  const keys = useMemo(() => targets.map((each) => each.lookup), [targets]);
  const query = useRpcKeyedQuery({ contract: sourceControlContract, method: "legacyChange", keys });
  return (
    <div
      data-bb-plugin="source-control"
      data-testid="sc-legacy-card"
      className="flex flex-col gap-2"
    >
      {targets.map((each) => {
        const found = query.data?.[each.lookup];
        if (found?.key)
          return (
            <ChangeCard
              key={each.lookup}
              changeKey={found.key}
              revision={each.head}
              threadId={threadId}
            />
          );
        return (
          <div
            key={each.lookup}
            className="w-full max-w-[576px] rounded-[8px] border border-solid border-border bg-background px-3 py-2 text-[12px] leading-4 text-muted-foreground"
          >
            {found ? (
              <>
                {found.problem ?? `Source Control cannot find ${each.label}.`}
                {each.url ? (
                  <>
                    {" "}
                    <UrlLink href={each.url}>Open {each.label} on GitHub</UrlLink>
                  </>
                ) : null}
              </>
            ) : query.error ? (
              `Could not look up ${each.label}.`
            ) : (
              <span className="inline-block h-4 w-40 animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
            )}
          </div>
        );
      })}
    </div>
  );
}
