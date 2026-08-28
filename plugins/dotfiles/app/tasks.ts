import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { TaskId } from "../server/domain.ts";
import { dotfilesQueryClient } from "./query-client.ts";
import { rpc } from "./rpc.ts";

export type QuickTask = Extract<TaskId, "render" | "check" | "apply:dry" | "sync:pull"> | "publish";

export const quickTasks: readonly QuickTask[] = [
  "render",
  "check",
  "apply:dry",
  "sync:pull",
  "publish",
];

export type TaskRun =
  | { readonly status: "running"; readonly id: string }
  | {
      readonly status: "done";
      readonly id: string;
      readonly exitCode: number;
      readonly output: string;
    }
  | { readonly status: "failed"; readonly id: string; readonly message: string };

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
  run(task: QuickTask): void;
  dismiss(): void;
}

export function useTasks(): Tasks {
  const client = rpc.useClient();
  const { current, renderStale } = useSyncExternalStore(subscribe, getSnapshot);
  return {
    current,
    renderStale,
    run(task) {
      if (snapshot.current?.status === "running") return;
      const id = task === "publish" ? "sync" : task;
      emit({ ...snapshot, current: { status: "running", id } });
      void (async () => {
        try {
          const result =
            task === "publish" ? await client.publish() : await client.runTask({ task });
          const clearsRenderStale =
            result.exitCode === 0 && (task === "render" || task === "publish");
          emit({
            current: { status: "done", id, exitCode: result.exitCode, output: result.output },
            renderStale: clearsRenderStale ? false : snapshot.renderStale,
          });
          if (result.exitCode === 0) toast.success(`${id} succeeded`);
          else toast.error(`${id} exited with code ${result.exitCode}`);
          if (task === "sync:pull" || task === "publish") {
            await dotfilesQueryClient.invalidateQueries({ queryKey: rpc.readFile.queryKey() });
          }
        } catch (error) {
          emit({ ...snapshot, current: { status: "failed", id, message: errorMessage(error) } });
          toast.error(`${task} failed: ${errorMessage(error)}`);
        } finally {
          await dotfilesQueryClient.invalidateQueries({ queryKey: rpc.overview.queryKey() });
        }
      })();
    },
    dismiss() {
      if (snapshot.current === null || snapshot.current.status === "running") return;
      emit({ ...snapshot, current: null });
    },
  };
}
