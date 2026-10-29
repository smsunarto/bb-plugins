import { instructionLink } from "./instruction-link.ts";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm text-destructive">
          Failed to load dotfiles: {errorMessage(overview.error)}
        </p>
        <Button variant="outline" onClick={() => void overview.refetch()}>
          Retry
        </Button>
      </div>
    );
  }
  if (overview.data.state === "offline") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {overview.data.host.name} is not connected.
      </div>
    );
  }
  if (!overview.data.repoExists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-foreground">
          No dotfiles repository at {overview.data.repoPath} on {overview.data.host.name}.
        </p>
        <p className="text-sm text-muted-foreground">
          Pick another machine in the Files tab, or set repoPath in the Dotfiles plugin settings.
        </p>
      </div>
    );
  }
  if (nav.path === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file in the Files or Workflows tab.
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
      <div className="flex h-full min-h-0 flex-col">
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
  const dirtyCount = overview.data.gitEntries.length;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {overview.data.host.name} · {overview.data.branch} ·{" "}
      {dirtyCount === 0 ? "clean" : `${dirtyCount} dirty`}
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
