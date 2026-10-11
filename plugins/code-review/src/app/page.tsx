import type { ReactNode } from "react";
import { UrlLink, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary, pluginQueryClient } from "@bb-kit/core/rpc/query";
import { parseBranchSubPath, parsePrSubPath, prKey, sameRef } from "../shared/schema.ts";
import type { Inbox as InboxData, PrRoute, Status } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { PANEL_PATH } from "./format.ts";
import { Inbox, UnpublishedOnly } from "./inbox.tsx";
import { LocalBranchView } from "./local-branch.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, errorText } from "./notice.tsx";
import { PrView } from "./pr-view.tsx";
import { rpc } from "./rpc.ts";

const SHELL = "flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-xs text-foreground";
const GH_INSTALL_URL = "https://cli.github.com";

/** Whether gh is installed and signed in only changes when the reader fixes it, and Try again asks again then. */
const STATUS_QUERY = { staleTime: 5 * 60_000 } as const;

/**
 * The Code Review page. The URL is the state: `subPath` is empty when no pull
 * request is open, or names a pull request or an unpublished branch, and its
 * tab. The inbox lives in the page's Inbox tab, which reads the same URL.
 */
export function CodeReviewPage({ subPath }: PluginNavPanelProps) {
  return (
    <PluginQueryBoundary>
      <TooltipProvider delayDuration={400}>
        <Page subPath={subPath} />
      </TooltipProvider>
    </PluginQueryBoundary>
  );
}

function Page({ subPath }: { subPath: string }) {
  const status = rpc.status.useQuery(STATUS_QUERY);
  const branch = parseBranchSubPath(subPath);
  // A local branch is read and reviewed without GitHub, so gh does not gate it.
  if (branch) {
    return (
      <section aria-label="Unpublished branch" className={cn(SHELL, "flex-col")}>
        <LocalBranchView key={branch.id} id={branch.id} tab={branch.tab} />
      </section>
    );
  }
  if (!status.data) {
    return (
      <div className={cn(SHELL, "flex-col p-4")}>
        {status.isError ? (
          <Notice
            tone="error"
            title="Code Review could not start"
            action={<RetryButton onRetry={() => void status.refetch()} />}
          >
            {errorText(status.error)}
          </Notice>
        ) : (
          <Loading label="Connecting to GitHub…" />
        )}
      </div>
    );
  }
  if (!status.data.ok) {
    return (
      <div className={cn(SHELL, "items-center justify-center p-6")}>
        <GitHubUnavailable
          status={status.data}
          retrying={status.isFetching}
          onRetry={() => void status.refetch()}
        />
      </div>
    );
  }

  const route = parsePrSubPath(subPath);
  const account = route ? routeAccount(route, status.data.login) : null;
  return (
    <section aria-label="Pull request" className={cn(SHELL, "flex-col")}>
      {route && account ? (
        // Keyed, so a different pull request, or the same one as another
        // account, starts from its own scroll and drafts.
        <PrView
          key={`${account}:${prKey(route.ref)}`}
          prRef={route.ref}
          account={account}
          tab={route.tab}
        />
      ) : subPath.replace(/^\/+|\/+$/g, "") !== "" ? (
        <UnknownPage />
      ) : (
        <NothingSelected />
      )}
    </section>
  );
}

/**
 * The account a pull request opens as: the one its URL names, else the
 * account whose inbox lists it, else gh's active account. A pasted link has
 * no account, and usually waits on someone in particular.
 */
function routeAccount(route: PrRoute, active: string): string {
  if (route.account) return route.account;
  const inbox = pluginQueryClient.getQueryData<InboxData>(rpc.inbox.queryKey());
  const listed = inbox
    ? [...inbox.assigned, ...inbox.team, ...inbox.authored, ...inbox.pinned].find((pr) =>
        sameRef(pr.ref, route.ref),
      )
    : undefined;
  return listed?.account ?? active;
}

/** The Inbox tab in the page's right panel: the viewer's queues, once gh can answer. */
export function InboxTab({ subPath }: PluginNavPanelProps) {
  return (
    <PluginQueryBoundary>
      <TooltipProvider delayDuration={400}>
        <InboxTabBody subPath={subPath} />
      </TooltipProvider>
    </PluginQueryBoundary>
  );
}

function InboxTabBody({ subPath }: { subPath: string }) {
  const status = rpc.status.useQuery(STATUS_QUERY);
  if (status.data?.ok) {
    return (
      <nav aria-label="Pull request inbox" className={cn(SHELL, "flex-col")}>
        <Inbox
          selected={parsePrSubPath(subPath)?.ref ?? null}
          selectedBranch={parseBranchSubPath(subPath)?.id ?? null}
        />
      </nav>
    );
  }
  // The page explains what gh needs. Pull requests wait until gh can answer;
  // unpublished branches need no GitHub, so they still list.
  return (
    <div className={cn(SHELL, "flex-col gap-3 p-3 text-muted-foreground")}>
      {status.data || status.isError ? (
        <>
          <p>GitHub is unavailable. The page says how to fix it.</p>
          <UnpublishedOnly selected={parseBranchSubPath(subPath)?.id ?? null} />
        </>
      ) : (
        <Loading label="Connecting to GitHub…" />
      )}
    </div>
  );
}

/** A shell command inside prose. */
function Command({ children }: { children: string }) {
  return (
    <code className="rounded bg-secondary px-1 py-px font-mono text-foreground" translate="no">
      {children}
    </code>
  );
}

const UNAVAILABLE: Record<
  Extract<Status, { ok: false }>["reason"],
  { icon: string; title: string; detail: ReactNode }
> = {
  "gh-missing": {
    icon: "Terminal",
    title: "Install the GitHub CLI",
    detail: (
      <>
        Code Review reads GitHub through <Command>gh</Command> on the machine running bb, and it is
        not installed there. Install it, sign in with <Command>gh auth login</Command>, then try
        again.
      </>
    ),
  },
  unauthenticated: {
    icon: "Github",
    title: "Sign in to GitHub",
    detail: (
      <>
        Code Review uses the account <Command>gh</Command> is signed in to. Run{" "}
        <Command>gh auth login</Command> on the machine running bb, then try again.
      </>
    ),
  },
  failed: {
    icon: "AlertTriangle",
    title: "Could not reach GitHub",
    detail: (
      <>
        <Command>gh</Command> is installed but could not answer. Check{" "}
        <Command>gh auth status</Command> on the machine running bb, then try again.
      </>
    ),
  },
};

/** The whole page, while gh cannot be used: what is wrong and the command that fixes it. */
function GitHubUnavailable({
  status,
  retrying,
  onRetry,
}: {
  status: Extract<Status, { ok: false }>;
  retrying: boolean;
  onRetry: () => void;
}) {
  const copy = UNAVAILABLE[status.reason];
  return (
    <section
      aria-labelledby="code-review-unavailable"
      className="flex max-w-sm flex-col items-center text-center text-muted-foreground"
    >
      <Icon name={copy.icon} className="mb-3 size-6 text-subtle-foreground" aria-hidden />
      <h2 id="code-review-unavailable" className="text-sm font-semibold text-foreground">
        {copy.title}
      </h2>
      <p className="mt-1.5 leading-relaxed">{copy.detail}</p>
      {status.message ? (
        <p className="mt-2 max-w-full font-mono text-[11px] break-words text-subtle-foreground">
          {status.message}
        </p>
      ) : null}
      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" className="h-7 px-3 text-xs" disabled={retrying} onClick={onRetry}>
          {retrying ? "Checking…" : "Try again"}
        </Button>
        {status.reason === "gh-missing" ? (
          <UrlLink
            href={GH_INSTALL_URL}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-primary underline-offset-4 hover:underline"
          >
            Install gh
            <Icon name="ExternalLink" className="size-3" aria-hidden />
          </UrlLink>
        ) : null}
      </div>
    </section>
  );
}

function NothingSelected() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6 text-center text-muted-foreground">
      <Icon name="GitPullRequest" className="mb-2 size-6 text-subtle-foreground" aria-hidden />
      <p className="font-medium text-foreground">Select a pull request</p>
      <p className="mt-1 max-w-64 leading-normal">
        Choose one in the Inbox tab, or paste a GitHub link at its top.
      </p>
    </div>
  );
}

function UnknownPage() {
  const navigate = useBbNavigate();
  return (
    <div className="p-4">
      <Notice
        tone="info"
        title="Nothing here"
        action={
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2.5 text-xs font-normal"
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: "", replace: true })}
          >
            Back to inbox
          </Button>
        }
      >
        This link does not name a pull request.
      </Notice>
    </div>
  );
}
