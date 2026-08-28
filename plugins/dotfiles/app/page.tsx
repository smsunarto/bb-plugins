import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { FileView } from "./file-view.tsx";
import { DotfilesBoundary } from "./query-client.ts";
import { rpc } from "./rpc.ts";
import { useDotfilesRoute } from "./route.ts";
import { errorMessage } from "./tasks.ts";

function DotfilesPageBody(props: PluginNavPanelProps): ReactElement {
  const nav = useDotfilesRoute(props.subPath);
  const overview = rpc.overview.useQuery();

  if (overview.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading dotfiles…
      </div>
    );
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
  if (!overview.data.repoExists) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <p className="text-sm text-foreground">
          No dotfiles repository at {overview.data.repoPath}.
        </p>
        <p className="text-sm text-muted-foreground">
          Configure repoPath in the Dotfiles plugin settings.
        </p>
      </div>
    );
  }
  if (nav.path === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a file in the Files tab.
      </div>
    );
  }
  return <FileView key={nav.path} path={nav.path} />;
}

export function DotfilesPage(props: PluginNavPanelProps): ReactElement {
  return (
    <DotfilesBoundary>
      <div className="flex h-full min-h-0 flex-col">
        <DotfilesPageBody {...props} />
      </div>
    </DotfilesBoundary>
  );
}

function RepoStatusBadgeBody(): ReactElement | null {
  const overview = rpc.overview.useQuery();
  if (overview.data === undefined) return null;
  const dirtyCount = overview.data.gitEntries.length;
  return (
    <span className="truncate text-xs text-muted-foreground">
      {overview.data.branch} · {dirtyCount === 0 ? "clean" : `${dirtyCount} dirty`}
    </span>
  );
}

export function RepoStatusBadge(_props: PluginNavPanelProps): ReactElement {
  return (
    <DotfilesBoundary>
      <RepoStatusBadgeBody />
    </DotfilesBoundary>
  );
}
