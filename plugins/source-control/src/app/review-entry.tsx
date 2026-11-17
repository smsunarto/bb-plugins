/**
 * The Source Control nav panel's parts: the review page, the Changes nav as
 * its sidebar, and the nav badge and page title, which read only what the
 * page has already cached.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useSidebarColumnFill } from "@bb-plugins/ui/sidebar-fill";
import { useMemo, useRef } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { parseReviewPath } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { useIsCompactViewport } from "./components/ui/hooks/use-compact-viewport.tsx";
import { useKeepPageOnEscape } from "./escape.ts";
import { ChangesList } from "./page/changes-nav.tsx";
import { ReviewPage } from "./page/review-page.tsx";

type PanelProps = { subPath: string };

/** The nav panel's page: the selected Change's review. Escape never leaves it. */
export function ReviewPanel({ subPath }: PanelProps) {
  useKeepPageOnEscape();
  return <ReviewPage subPath={subPath} />;
}

/**
 * The nav panel's sidebar: the Changes nav. In a phone drawer it fills the column and scrolls its
 * own list, so its footer sits at the screen's edge rather than above the home indicator's strip.
 */
export function ReviewSidebar({ subPath }: PanelProps) {
  const compact = useIsCompactViewport();
  const root = useRef<HTMLDivElement>(null);
  // workaround:scott-docs/sidebar-fill (manual removal; see workarounds.json)
  useSidebarColumnFill(root, compact);
  return (
    <div ref={root} className="flex min-h-0 min-w-0 flex-col">
      <ChangesList subPath={subPath} variant="nav" drawer={compact} />
    </div>
  );
}

const NO_KEYS: readonly string[] = [];

/**
 * Reviews the reader is asked for, from inbox reads already cached by the
 * page. Disabled reads: the badge never asks the server or GitHub for
 * anything itself, so it shows only after the page has been opened.
 */
export function useReviewBadge() {
  const sources = useRpcQuery({
    contract: sourceControlContract,
    method: "pageSources",
    input: {},
    enabled: false,
  });
  const accounts = sources.data?.accounts;
  const logins = useMemo(() => accounts?.map((account) => account.login) ?? NO_KEYS, [accounts]);
  const inbox = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "inbox",
    keys: logins,
    enabled: false,
  });
  const asked = useMemo(() => {
    const keys = new Set<ChangeKey>();
    for (const source of Object.values(inbox.data ?? {}))
      for (const row of source.read?.rows ?? []) if (row.asked) keys.add(row.key);
    return keys.size;
  }, [inbox.data]);
  if (asked === 0) return null;
  return {
    count: asked,
    tone: "warning" as const,
    label: asked === 1 ? "1 review requested" : `${asked} reviews requested`,
  };
}

/** The selected Change's title after the panel's name, from the page's own cached read. */
export function useReviewTitle({ subPath }: PanelProps) {
  const key = useMemo(() => parseReviewPath(subPath).key, [subPath]);
  const detail = useRpcKeyedQuery({
    contract: sourceControlContract,
    method: "changeDetail",
    keys: key ? [key] : NO_KEYS,
    enabled: false,
  });
  const row = key ? detail.data?.[key] : undefined;
  if (row?.state !== "change") return null;
  return { title: row.row.number !== null ? `#${row.row.number} ${row.row.title}` : row.row.title };
}
