import { instructionLink } from "./instruction-link.ts";
import { useState } from "react";
import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { Item, ItemContent, ItemTitle } from "@/components/ui/item";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { queryClient } from "./query.ts";
import { HostPicker, usePanelOverview } from "./host-picker.tsx";
import { queryKey, useRpcMutation, type RPCOutput } from "./rpc.ts";
import { useDotfilesRoute, type DotfilesNavigation } from "./route.ts";
import { errorMessage } from "./tasks.ts";

type ReadyOverview = Extract<RPCOutput<"overview">, { state: "ready" }>;
type OverviewFile = ReadyOverview["groups"][number]["files"][number];

interface SkillRow {
  readonly name: string;
  readonly path: string;
}

/** A removal names the machine whose file list the reader clicked. */
interface PendingRemoval extends SkillRow {
  readonly host: ReadyOverview["host"];
}

/** The machine header and file list; `workflows` shows the workflow group instead of the rest. */
export function FilesSection(props: PluginNavPanelProps & { workflows: boolean }): ReactElement {
  const nav = useDotfilesRoute(props.subPath);
  const overview = usePanelOverview();
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const removeSkillMutation = useRpcMutation("removeSkill", {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKey("overview") }),
  });

  async function removeSkill({ name, path, host: machine }: PendingRemoval): Promise<void> {
    try {
      const result = await removeSkillMutation.mutateAsync({ hostId: machine.id, name });
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

  const ready = overview.data?.state === "ready" ? overview.data : undefined;
  const dirtyCount = ready?.gitEntries.length ?? 0;

  return (
    <>
      <div className="border-b border-border p-3">
        {ready !== undefined && (
          <div className="mb-1 text-sm font-medium text-foreground">
            {ready.branch}
            <Badge variant="count" className="ml-2">
              {dirtyCount === 0 ? "clean" : `${dirtyCount} dirty`}
            </Badge>
          </div>
        )}
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <HostPicker />
          {ready !== undefined && <span className="min-w-0 truncate">{ready.repoPath}</span>}
        </div>
      </div>
      {props.workflows && (
        <p className="shrink-0 border-b border-border px-4 py-3 text-xs text-muted-foreground">
          After saving, run Refresh agent skills in Tasks to update installed copies, then start a
          new agent session.
        </p>
      )}
      {overview.isPending ? (
        <div className="h-full" aria-busy="true" aria-label="Loading dotfiles" />
      ) : overview.isError ? (
        <div className="p-2">
          <Alert variant="destructive" role="none">
            <AlertTitle>Failed to load dotfiles</AlertTitle>
            <AlertDescription>{errorMessage(overview.error)}</AlertDescription>
            <AlertAction>
              <Button size="sm" variant="outline" onClick={() => void overview.refetch()}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        </div>
      ) : overview.data.state === "offline" ? (
        <EmptyState className="m-4" message={`${overview.data.host.name} is not connected.`} />
      ) : overview.data.state === "noRepository" ? (
        <EmptyState
          className="m-4"
          message={`No dotfiles repository at ${overview.data.repoPath}.`}
        />
      ) : (
        <FileList
          overview={overview.data}
          workflows={props.workflows}
          nav={nav}
          onRemove={setPendingRemoval}
        />
      )}
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
                Remove skill "{pendingRemoval.name}" via npx skills on {pendingRemoval.host.name}?
                This deletes it for every agent on that machine.
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

function FileList({
  overview: ready,
  workflows,
  nav,
  onRemove,
}: {
  readonly overview: ReadyOverview;
  readonly workflows: boolean;
  readonly nav: DotfilesNavigation;
  readonly onRemove: (removal: PendingRemoval) => void;
}): ReactElement {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-2">
      {ready.groups
        .filter((group) => (group.id === "workflows") === workflows)
        .map((group) => (
          <div key={group.id} className="mb-3">
            <div className="px-2 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </div>
            {group.files.map((item) => (
              <FileRow
                key={item.path}
                item={item}
                instructionHref={instructionLink(item.path, ready.host.id, ready.repoPath)}
                nav={nav}
                onRemove={(row) => onRemove({ ...row, host: ready.host })}
              />
            ))}
          </div>
        ))}
    </div>
  );
}

function FileRow({
  item,
  instructionHref,
  nav,
  onRemove,
}: {
  readonly item: OverviewFile;
  readonly instructionHref: string | null;
  readonly nav: DotfilesNavigation;
  readonly onRemove: (row: SkillRow) => void;
}): ReactElement {
  const selected = nav.path === item.path;
  const removeSkillName = item.removeSkillName;
  return (
    // The link or button is the row's Item, so the whole row height is the tap target.
    <div className="group/row flex w-full items-center gap-1">
      {instructionHref ? (
        <Item
          asChild
          size="row"
          aria-current={selected ? "true" : undefined}
          className="min-w-0 flex-1"
        >
          <UrlLink href={instructionHref} title="Edit in Agent Instructions">
            <FileRowLabel item={item} />
          </UrlLink>
        </Item>
      ) : (
        <Item asChild size="row" className="min-w-0 flex-1">
          <button
            type="button"
            disabled={!item.exists}
            aria-current={selected ? "true" : undefined}
            onClick={() => nav.open(item.path)}
            title={item.note}
          >
            <FileRowLabel item={item} />
          </button>
        </Item>
      )}
      {removeSkillName !== undefined && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove skill ${item.title}`}
              onClick={() => onRemove({ name: removeSkillName, path: item.path })}
              className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 max-md:pointer-coarse:size-9 max-md:pointer-coarse:opacity-100"
            >
              <Icon name="X" className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{`Remove ${item.title} (npx skills remove)`}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function FileRowLabel({ item }: { readonly item: OverviewFile }): ReactElement {
  return (
    <>
      <ItemContent>
        <ItemTitle>{item.title}</ItemTitle>
      </ItemContent>
      {!item.exists && <Badge variant="danger">missing</Badge>}
      {item.dirty && (
        <span
          className="size-1.5 shrink-0 rounded-full bg-amber-500"
          aria-label="uncommitted changes"
        />
      )}
    </>
  );
}
