import { instructionLink } from "./instruction-link.ts";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, EmptyStatePanel } from "@/components/ui/empty-state";
import { FileView } from "./file-view.tsx";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query.ts";
import { usePanelOverview } from "./host-picker.tsx";
import { useDotfilesRoute } from "./route.ts";
import { errorMessage } from "./tasks.ts";

function DotfilesPageBody(props: PluginNavPanelProps): ReactElement {
  const nav = useDotfilesRoute(props.subPath);
  const overview = usePanelOverview();

  if (overview.isPending) {
    return <div className="h-full" aria-busy="true" aria-label="Loading dotfiles" />;
  }
  if (overview.isError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Alert variant="destructive" role="none" className="max-w-md">
          <AlertTitle>Failed to load dotfiles</AlertTitle>
          <AlertDescription>{errorMessage(overview.error)}</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" onClick={() => void overview.refetch()}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  }
  if (overview.data.state === "offline") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState message={`${overview.data.host.name} is not connected.`} />
      </div>
    );
  }
  if (overview.data.state === "noRepository") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyStatePanel className="flex max-w-md flex-col gap-2">
          <p className="text-foreground">
            No dotfiles repository at {overview.data.repoPath} on {overview.data.host.name}.
          </p>
          <p>
            Pick another machine in the sidebar's Files section, or set repoPath in the Dotfiles
            plugin settings.
          </p>
        </EmptyStatePanel>
      </div>
    );
  }
  if (nav.path === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState message="Select a file in the sidebar's Files or Workflows section." />
      </div>
    );
  }
  const { host: machine } = overview.data;
  const instructionHref = instructionLink(nav.path, machine.id, overview.data.repoPath);
  if (instructionHref)
    return (
      <div className="p-6 text-sm">
        <UrlLink className="text-primary underline" href={instructionHref}>
          Edit instructions and skills in Agent Instructions
        </UrlLink>
      </div>
    );
  return <FileView key={`${machine.id}:${nav.path}`} host={machine} path={nav.path} />;
}

export function DotfilesPage(props: PluginNavPanelProps): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      {/* Under bb Monokai on a phone the page runs under the home indicator. */}
      <div className="flex h-[calc(100%+var(--plugin-page-bottom-inset,0px))] mb-[calc(-1*var(--plugin-page-bottom-inset,0px))] min-h-0 flex-col">
        <DotfilesPageBody {...props} />
      </div>
    </QueryClientProvider>
  );
}

function RepoStatusBadgeBody(): ReactElement | null {
  const overview = usePanelOverview();
  if (overview.data === undefined) return null;
  if (overview.data.state === "offline") {
    return (
      <span className="truncate text-xs text-muted-foreground">
        {overview.data.host.name} · offline
      </span>
    );
  }
  if (overview.data.state === "noRepository") {
    return (
      <span className="truncate text-xs text-muted-foreground">
        {overview.data.host.name} · no repository
      </span>
    );
  }
  const dirtyCount = overview.data.gitEntries.length;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {overview.data.host.name} · {overview.data.branch}{" "}
      <Badge variant="count">{dirtyCount === 0 ? "clean" : `${dirtyCount} dirty`}</Badge>
    </span>
  );
}

export function RepoStatusBadge(_props: PluginNavPanelProps): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <RepoStatusBadgeBody />
    </QueryClientProvider>
  );
}
