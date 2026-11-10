/**
 * The Source Control nav panel's parts: the review page, the Changes nav as
 * its sidebar, and the nav badge and page title, which read only what the
 * page has already cached.
 */
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useMemo } from "react";
import type { ChangeKey } from "../core/ids.ts";
import { parseReviewPath } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { ChangesList } from "./page/changes-nav.tsx";
import { ReviewPage } from "./page/review-page.tsx";

type PanelProps = { subPath: string };

/** The nav panel's page: the selected Change's review. */
export function ReviewPanel({ subPath }: PanelProps) {
  return <ReviewPage subPath={subPath} />;
}

/** The nav panel's sidebar: the Changes nav. */
export function ReviewSidebar({ subPath }: PanelProps) {
  return <ChangesList subPath={subPath} variant="nav" />;
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
