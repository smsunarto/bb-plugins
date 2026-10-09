import type { ReactNode } from "react";
import { UrlLink, experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { PluginQueryBoundary } from "@bb-kit/core/rpc/query";
import { parsePrSubPath, prKey } from "../shared/schema.ts";
import type { Status } from "../shared/schema.ts";
import { Button } from "./components/ui/button.tsx";
import { TooltipProvider } from "./components/ui/tooltip.tsx";
import { PANEL_PATH } from "./format.ts";
import { Inbox } from "./inbox.tsx";
import { cn } from "./lib/utils.ts";
import { Loading, Notice, RetryButton, errorText } from "./notice.tsx";
import { PrView } from "./pr-view.tsx";
import { rpc } from "./rpc.ts";

const SHELL = "flex h-full min-h-0 min-w-0 overflow-hidden bg-background text-xs text-foreground";
const GH_INSTALL_URL = "https://cli.github.com";

/**
 * The Code Review page. The URL is the state: `subPath` is empty for the
 * inbox alone, or names a pull request and its tab. Wide, the inbox and the
 * pull request sit side by side; narrow, whichever the URL names fills it.
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
  // Whether gh is installed and signed in only changes when the reader
  // fixes it, and Try again asks again then.
  const status = rpc.status.useQuery({ staleTime: 5 * 60_000 });
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
  const showsDetail = subPath.replace(/^\/+|\/+$/g, "") !== "";
  return (
    <div className={cn(SHELL, "@container/page")}>
      <nav
        aria-label="Pull request inbox"
        className={cn(
          "min-h-0 w-full flex-col border-border @3xl/page:flex @3xl/page:w-80 @3xl/page:shrink-0 @3xl/page:border-r",
          showsDetail ? "hidden" : "flex",
        )}
      >
        <Inbox selected={route?.ref ?? null} />
      </nav>
      <section
        aria-label="Pull request"
        className={cn(
          "min-h-0 min-w-0 flex-1 flex-col @3xl/page:flex",
          showsDetail ? "flex" : "hidden",
        )}
      >
        {route ? (
          // Keyed, so a different pull request starts from its own scroll and drafts.
          <PrView key={prKey(route.ref)} prRef={route.ref} tab={route.tab} />
        ) : showsDetail ? (
          <UnknownPage />
        ) : (
          <NothingSelected />
        )}
      </section>
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
        Choose one from the inbox, or paste a GitHub link in the box above it.
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
