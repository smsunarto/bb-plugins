import { useState } from "react";
import {
  experimental_useSidebarThreads as useSidebarThreads,
  useBbNavigate,
  useRpc,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import type { initiativeRpcContract } from "@/lib/initiative-rpc";
import { projectDescendantCount } from "@/lib/initiative-ui";
import { useInitiatives } from "@/hooks/use-initiatives";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { InitiativeIcon, InitiativeIconPicker } from "@/components/projects/icons";
import { ArchiveProjectDialog } from "@/components/projects/archive-project-dialog";

/**
 * The project identity chip in the coordinator thread's header. Renders only
 * on coordinator threads — agent threads keep the stock header. The popover
 * is the project's metadata surface: inline rename, icon, description, and
 * the same archive flow as the rail.
 */
export function ProjectHeaderAction({
  threadId,
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const initiatives = useInitiatives();
  const { threads } = useSidebarThreads();
  const rpc = useRpc<typeof initiativeRpcContract>();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const initiative = initiatives.byCoordinator.get(threadId) ?? null;
  if (initiative === null) return null;

  const update = (patch: { name?: string; icon?: string; description?: string }) => {
    setError(null);
    rpc
      .call("updateInitiative", { initiativeId: initiative.id, ...patch })
      .catch((updateError: unknown) =>
        setError(updateError instanceof Error ? updateError.message : "Save failed"),
      );
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Project ${initiative.name}`}
            title={initiative.name}
            className={cn(
              "flex h-7 max-w-40 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
            )}
            data-project-header-chip={initiative.id}
          >
            <InitiativeIcon icon={initiative.icon} className="size-3.5" />
            {!isCompactViewport ? <span className="truncate">{initiative.name}</span> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="bottom"
          align="start"
          className="w-72 p-3"
          aria-label={`Edit ${initiative.name}`}
        >
          <div className="flex flex-col gap-2.5">
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Name</span>
              <input
                key={initiative.updatedAt}
                defaultValue={initiative.name}
                aria-label="Project name"
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name !== "" && name !== initiative.name) update({ name });
                }}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-ring"
              />
            </label>
            <div className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Icon</span>
              <InitiativeIconPicker value={initiative.icon} onChange={(icon) => update({ icon })} />
            </div>
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium text-muted-foreground">Description</span>
              <textarea
                key={`desc-${initiative.updatedAt}`}
                defaultValue={initiative.description}
                aria-label="Project description"
                rows={2}
                placeholder="What is this project about?"
                onBlur={(event) => {
                  const description = event.currentTarget.value.trim();
                  if (description !== initiative.description) update({ description });
                }}
                className="resize-none rounded-md border border-border bg-background px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-ring"
              />
            </label>
            {error !== null ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between pt-0.5">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setOpen(false);
                  navigate.openThreadPanel({
                    actionId: "project",
                    params: { tab: "overview" },
                  });
                }}
              >
                Project panel
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="text-destructive-text"
                onClick={() => {
                  setOpen(false);
                  setArchiveOpen(true);
                }}
              >
                Archive…
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      <ArchiveProjectDialog
        initiative={initiative}
        agentCount={projectDescendantCount(threads, initiative.coordinatorThreadId)}
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
      />
    </>
  );
}
