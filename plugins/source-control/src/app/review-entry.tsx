/**
 * The review page's eager half: thin shims that import the page module from
 * the plugin's own route on first render, and the nav badge and page title,
 * which read only what is already cached. Plugin bundles have no code
 * splitting, so everything heavy lives in `page/` and loads on first open,
 * as code-review's three.js kit does.
 */
import {
  experimental_usePluginId as usePluginId,
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useMemo, useState } from "react";
import { PAGE_ETAG } from "../../generated/page-version.ts";
import type { ChangeKey } from "../core/ids.ts";
import { parseReviewPath } from "../core/review.ts";
import { sourceControlContract } from "../contract/rpc.ts";
import { Bar, Button } from "./ui.tsx";

type PageModule = typeof import("./page/index.tsx");
type PanelProps = { subPath: string };

let loading: { url: string; module: Promise<PageModule> } | null = null;
let loaded: { url: string; module: PageModule } | null = null;

export function pageUrl(pluginId: string): string {
  return `/api/v1/plugins/${encodeURIComponent(pluginId)}/http/page.js?v=${PAGE_ETAG}`;
}

/** Keeps the module once imported; forgets a failed import so the next ask tries again. */
async function settle(url: string, module: Promise<PageModule>): Promise<void> {
  try {
    const value = await module;
    if (loading?.module === module) loaded = { url, module: value };
  } catch {
    if (loading?.module === module) loading = null;
  }
}

/** The page module, imported once per URL. A failed import is asked again next time. */
function loadPage(url: string): Promise<PageModule> {
  if (loading?.url !== url) {
    const module = import(/* @vite-ignore */ url) as Promise<PageModule>;
    loading = { url, module };
    void settle(url, module);
  }
  return loading.module;
}

type Loaded = { url: string; module: PageModule | null; failed: boolean };

function usePageModule(): { module: PageModule | null; failed: boolean; retry(): void } {
  const url = pageUrl(usePluginId());
  const [state, setState] = useState<Loaded>(() => ({
    url,
    module: loaded?.url === url ? loaded.module : null,
    failed: false,
  }));
  const current: Loaded = state.url === url ? state : { url, module: null, failed: false };
  const waiting = current.module === null && !current.failed;
  useEffect(() => {
    if (!waiting) return;
    let live = true;
    const apply = (next: Loaded) => {
      if (live) setState(next);
    };
    loadPage(url).then(
      (module) => apply({ url, module, failed: false }),
      () => apply({ url, module: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [url, waiting]);
  return {
    module: current.module,
    failed: current.failed,
    retry: () => setState({ url, module: null, failed: false }),
  };
}

/** Holds the page's shape while its module loads, so nothing shifts when it lands. */
function Loading({ failed, retry, sidebar }: { failed: boolean; retry(): void; sidebar: boolean }) {
  return (
    <div
      data-bb-plugin="source-control"
      data-testid="sc-page-loading"
      aria-busy={!failed}
      className="flex h-full min-h-0 flex-col gap-3 p-4 text-foreground"
    >
      {failed ? (
        <div role="alert" className="flex flex-col items-start gap-2">
          <p className="m-0 text-[12px] leading-5 text-muted-foreground">
            The review page didn't load. The bb server may be restarting.
          </p>
          <Button onClick={retry}>Try again</Button>
        </div>
      ) : sidebar ? (
        <>
          <Bar className="h-4 w-20" />
          <Bar className="h-7 w-full" />
          <Bar className="mt-2 h-14 w-full" />
          <Bar className="h-14 w-full" />
        </>
      ) : (
        <>
          <Bar className="h-3 w-40" />
          <Bar className="h-6 w-96 max-w-full" />
          <Bar className="h-3 w-72 max-w-full" />
        </>
      )}
    </div>
  );
}

export function ReviewPanel(props: PanelProps) {
  const page = usePageModule();
  if (page.module) return <page.module.ReviewPage {...props} />;
  return <Loading failed={page.failed} retry={page.retry} sidebar={false} />;
}

export function ReviewSidebar(props: PanelProps) {
  const page = usePageModule();
  if (page.module) return <page.module.ChangesSidebar {...props} />;
  return <Loading failed={page.failed} retry={page.retry} sidebar />;
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
