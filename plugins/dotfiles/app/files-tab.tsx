import { useState } from "react";
import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { OverviewResult } from "../server/rpc/overview.ts";
import { dotfilesQueryClient, DotfilesBoundary } from "./query-client.ts";
import { rpc } from "./rpc.ts";
import { useDotfilesRoute, type DotfilesNavigation } from "./route.ts";
import { errorMessage } from "./tasks.ts";

type OverviewFile = OverviewResult["groups"][number]["files"][number];

interface PendingRemoval {
  readonly name: string;
  readonly path: string;
}

function FilesTabBody(props: PluginNavPanelProps): ReactElement {
  const nav = useDotfilesRoute(props.subPath);
  const overview = rpc.overview.useQuery();
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const removeSkillMutation = rpc.removeSkill.useMutation({
    onSuccess: () =>
      dotfilesQueryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() }),
  });

  async function removeSkill({ name, path }: PendingRemoval): Promise<void> {
    try {
      const result = await removeSkillMutation.mutateAsync({ name });
      if (result.outcome === "not-found") {
        toast.error(`Skill ${name} no longer exists`);
        return;
      }
      if (result.exitCode === 0) {
        toast.success(`Removed skill ${name}`);
        if (nav.path === path) nav.clear();
      } else {
        toast.error(`Removing ${name} failed (exit ${result.exitCode})`);
      }
    } catch (error) {
      toast.error(`Removing ${name} failed: ${errorMessage(error)}`);
    }
  }

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

  const dirtyCount = overview.data.gitEntries.length;

  return (
    <>
      <div className="border-b border-border p-3">
        <div className="text-sm font-medium text-foreground">
          {overview.data.branch}
          <span className="ml-2 text-xs text-muted-foreground">
            {dirtyCount === 0 ? "clean" : `${dirtyCount} dirty`}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {overview.data.repoPath}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {overview.data.groups.map((group) => (
          <div key={group.id} className="mb-3">
            <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </div>
            {group.files.map((item) => (
              <FileRow
                key={item.path}
                item={item}
                nav={nav}
                onRemove={(removal) => setPendingRemoval(removal)}
              />
            ))}
          </div>
        ))}
      </div>
      {pendingRemoval !== null && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingRemoval(null);
          }}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Remove skill</DialogTitle>
              <DialogDescription>
                Remove skill "{pendingRemoval.name}" via npx skills? This deletes it for every
                agent.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingRemoval(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setPendingRemoval(null);
                  void removeSkill(pendingRemoval);
                }}
              >
                Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function FileRow({
  item,
  nav,
  onRemove,
}: {
  readonly item: OverviewFile;
  readonly nav: DotfilesNavigation;
  readonly onRemove: (removal: PendingRemoval) => void;
}): ReactElement {
  const selected = nav.path === item.path;
  const removeSkillName = item.removeSkillName;
  return (
    <div
      className={`group/row flex w-full items-center gap-2 rounded-md px-2 py-1 text-sm ${
        selected ? "bg-accent text-accent-foreground" : "text-foreground hover:bg-accent/50"
      }`}
    >
      <button
        type="button"
        disabled={!item.exists}
        aria-current={selected ? "true" : undefined}
        onClick={() => nav.open(item.path)}
        className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
        title={item.note}
      >
        <span className="min-w-0 flex-1 truncate">{item.title}</span>
        {!item.exists && <span className="text-xs text-destructive">missing</span>}
        {item.dirty && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-amber-500"
            aria-label="uncommitted changes"
          />
        )}
      </button>
      {removeSkillName !== undefined && (
        <button
          type="button"
          aria-label={`Remove skill ${item.title}`}
          title={`Remove ${item.title} (npx skills remove)`}
          onClick={() => onRemove({ name: removeSkillName, path: item.path })}
          className="shrink-0 rounded px-1 text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
        >
          ×
        </button>
      )}
    </div>
  );
}

export function DotfilesFilesTab(props: PluginNavPanelProps): ReactElement {
  return (
    <DotfilesBoundary>
      <div className="flex h-full min-h-0 flex-col bg-sidebar">
        <FilesTabBody {...props} />
      </div>
    </DotfilesBoundary>
  );
}
