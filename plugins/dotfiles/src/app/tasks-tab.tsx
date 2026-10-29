import { useState } from "react";
import type { ReactElement } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query.ts";
import { usePanelOverview } from "./host-picker.tsx";
import { quickTasks, useTasks } from "./tasks.ts";

function TasksTabBody(): ReactElement {
  const tasks = useTasks();
  const overview = usePanelOverview();
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const running = tasks.current?.status === "running";
  const ready = overview.data?.state === "ready" ? overview.data : null;
  const disabled = running || ready === null;

  return (
    <>
      <div className="border-b border-border p-3">
        <div className="flex flex-wrap gap-1">
          {quickTasks.map((task) => {
            const label = task === "publish" ? "sync" : task;
            const isRunning = running && tasks.current?.id === label;
            return (
              <Button
                key={task}
                size="sm"
                variant={task === "publish" ? "destructive" : "outline"}
                disabled={disabled}
                onClick={() => {
                  if (task === "publish") setConfirmingPublish(true);
                  else if (ready !== null) tasks.run(task, ready.host);
                }}
              >
                {task === "install:agent-plugins"
                  ? isRunning
                    ? "Refreshing agent skills…"
                    : "Refresh agent skills"
                  : isRunning
                    ? `${label}…`
                    : label}
              </Button>
            );
          })}
        </div>
        {overview.data !== undefined && (
          <div className="mt-2 truncate text-xs text-muted-foreground">
            {overview.data.state === "offline"
              ? `${overview.data.host.name} is not connected.`
              : `Runs on ${overview.data.host.name}`}
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tasks.current === null ? (
          <div className="p-4 text-sm text-muted-foreground">Run a task to see its output.</div>
        ) : tasks.current.status === "running" ? (
          <div className="p-4 text-sm text-muted-foreground">
            {tasks.current.id} on {tasks.current.host} — running…
          </div>
        ) : tasks.current.status === "failed" ? (
          <div className="p-4 text-sm text-destructive">
            {tasks.current.id} on {tasks.current.host} — failed: {tasks.current.message}
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-4 py-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                {tasks.current.id} on {tasks.current.host} — exit {tasks.current.exitCode}
              </span>
              <Button size="sm" variant="ghost" onClick={tasks.dismiss}>
                Dismiss
              </Button>
            </div>
            <pre className="whitespace-pre-wrap px-4 pb-4 font-mono text-xs text-foreground">
              {tasks.current.output || "(no output)"}
            </pre>
          </>
        )}
      </div>
      {confirmingPublish && ready !== null && (
        <Dialog open onOpenChange={setConfirmingPublish}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Publish</DialogTitle>
              <DialogDescription>
                Publish from {ready.host.name}? This rebases onto origin/main and pushes.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmingPublish(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmingPublish(false);
                  tasks.run("publish", ready.host);
                }}
              >
                Publish
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

export function DotfilesTasksTab(_props: PluginNavPanelProps): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-full min-h-0 flex-col bg-sidebar">
        <TasksTabBody />
      </div>
    </QueryClientProvider>
  );
}
