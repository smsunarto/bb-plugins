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
import type { ChangeKey } from "../core/ids.ts";
import { ChangeCard } from "./chat-card.tsx";
import { ChangeGroup, type GroupItem } from "./group-card.tsx";

export const LEGACY_REVIEW_DIRECTIVE = "code-review";

const BRANCH_ID = /^[0-9a-f]{12}$/;
const HEAD = /^[0-9a-f]{4,64}$/i;

type Target = { lookup: string; label: string; head: string | null; url: string | null };

/** A pull request named as `owner/repo#12` or by its GitHub URL, as a target the server resolves. */
export function pullRequestTarget(reference: string): Target | null {
  const ref = parsePrReference(reference);
  if (!ref) return null;
  return {
    lookup: `pr:${prKey(ref).toLowerCase()}`,
    label: prKey(ref),
    head: null,
    url: `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
  };
}

function target(raw: Record<string, unknown>): Target | null {
  if (typeof raw.pr === "string")
    return /^[^/]+\/[^#]+#\d+$/.test(raw.pr) ? pullRequestTarget(raw.pr) : null;
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

function LegacyNote({ target, found, failed }: { target: Target; found: Found; failed: boolean }) {
  return (
    <div className="w-full max-w-[576px] rounded-[8px] border border-solid border-border bg-background px-3 py-2 text-[12px] leading-4 text-muted-foreground">
      {found ? (
        <>
          {found.problem ?? `Source Control cannot find ${target.label}.`}
          {target.url ? (
            <>
              {" "}
              <UrlLink href={target.url}>Open {target.label} on GitHub</UrlLink>
            </>
          ) : null}
        </>
      ) : failed ? (
        `Could not look up ${target.label}.`
      ) : (
        <span className="inline-block h-4 w-40 animate-pulse rounded bg-surface-raised motion-reduce:animate-none" />
      )}
    </div>
  );
}

type Found = { key: ChangeKey | null; problem: string | null } | undefined;

/** One target as its Change card; several as one grouped card with Ship all and Merge all. */
export function LegacyCards({ targets, threadId }: { targets: Target[]; threadId: string }) {
  const keys = useMemo(() => targets.map((each) => each.lookup), [targets]);
  const query = useRpcKeyedQuery({ contract: sourceControlContract, method: "legacyChange", keys });
  const data = query.data;
  const failed = query.error !== null;
  const items = useMemo(
    () =>
      targets.map((each): GroupItem => {
        const found = data?.[each.lookup];
        return found?.key
          ? { id: each.lookup, entry: { key: found.key, revision: each.head } }
          : { id: each.lookup, note: <LegacyNote target={each} found={found} failed={failed} /> };
      }),
    [targets, data, failed],
  );
  if (items.length > 1)
    return (
      <div data-bb-plugin="source-control" data-testid="sc-legacy-card">
        <ChangeGroup items={items} threadId={threadId} />
      </div>
    );
  const [only] = items;
  return (
    <div data-bb-plugin="source-control" data-testid="sc-legacy-card" className="flex flex-col">
      {only && "entry" in only ? (
        <ChangeCard changeKey={only.entry.key} revision={only.entry.revision} threadId={threadId} />
      ) : (
        only?.note
      )}
    </div>
  );
}
