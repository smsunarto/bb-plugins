import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { pluginQueryClient } from "@bb-kit/core/rpc/query";
import { rpc, type RPCInput } from "./rpc.ts";

type TaskId = RPCInput<"runTask">["task"];

export type QuickTask =
  | Extract<TaskId, "render" | "install:agent-plugins" | "check" | "apply:dry" | "sync:pull">
  | "publish";

export const quickTasks: readonly QuickTask[] = [
  "render",
  "install:agent-plugins",
  "check",
  "apply:dry",
  "sync:pull",
  "publish",
];

/** The machine a task runs on. */
export interface TaskHost {
  readonly id: string;
  readonly name: string;
}

export type TaskRun =
  | { readonly status: "running"; readonly id: string; readonly host: string }
  | {
      readonly status: "done";
      readonly id: string;
      readonly host: string;
      readonly exitCode: number;
      readonly output: string;
    }
  | {
      readonly status: "failed";
      readonly id: string;
      readonly host: string;
      readonly message: string;
    };

interface TaskStoreSnapshot {
  readonly current: TaskRun | null;
  readonly renderStale: boolean;
}

let snapshot: TaskStoreSnapshot = { current: null, renderStale: false };
const listeners = new Set<() => void>();

function emit(next: TaskStoreSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): TaskStoreSnapshot {
  return snapshot;
}

export function markRenderStale(): void {
  emit({ ...snapshot, renderStale: true });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface Tasks {
  readonly current: TaskRun | null;
  readonly renderStale: boolean;
  run(task: QuickTask, host: TaskHost): void;
  dismiss(): void;
}

export function useTasks(): Tasks {
  const client = rpc.useClient();
  const { current, renderStale } = useSyncExternalStore(subscribe, getSnapshot);
  return {
    current,
    renderStale,
    run(task, host) {
      if (snapshot.current?.status === "running") return;
      const id = task === "publish" ? "sync" : task;
      emit({ ...snapshot, current: { status: "running", id, host: host.name } });
      void (async () => {
        try {
          const result =
            task === "publish"
              ? await client.publish({ hostId: host.id })
              : await client.runTask({ hostId: host.id, task });
          const clearsRenderStale =
            result.exitCode === 0 && (task === "render" || task === "publish");
          emit({
            current: {
              status: "done",
              id,
              host: host.name,
              exitCode: result.exitCode,
              output: result.output,
            },
            renderStale: clearsRenderStale ? false : snapshot.renderStale,
          });
          if (result.exitCode === 0) toast.success(`${id} succeeded on ${host.name}`);
          else toast.error(`${id} on ${host.name} exited with code ${result.exitCode}`);
          if (task === "sync:pull" || task === "publish") {
            await pluginQueryClient.invalidateQueries({ queryKey: rpc.readFile.queryKey() });
          }
        } catch (error) {
          emit({
            ...snapshot,
            current: { status: "failed", id, host: host.name, message: errorMessage(error) },
          });
          toast.error(`${task} failed: ${errorMessage(error)}`);
        } finally {
          await pluginQueryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() });
        }
      })();
    },
    dismiss() {
      if (snapshot.current === null || snapshot.current.status === "running") return;
      emit({ ...snapshot, current: null });
    },
  };
}
