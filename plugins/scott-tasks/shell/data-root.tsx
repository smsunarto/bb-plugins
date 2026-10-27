import { useEffect, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { TasksRpcContract } from "../shared/contract.js";
import { setTasksRpc, tasksQueryClient } from "./query.js";
import { useTasksSync } from "./sync.js";

/**
 * Join the plugin's shared cache from a Tasks surface or hook slot: supply
 * the RPC client, keep Query's focus and online listeners mounted, and feed
 * realtime signals into the cache.
 */
export function useTasksDataRoot(): void {
  // Assigned during render so this surface's first reads already have a client.
  setTasksRpc(useRpc<TasksRpcContract>());
  useEffect(() => {
    tasksQueryClient.mount();
    return () => tasksQueryClient.unmount();
  }, []);
  useTasksSync();
}

/** Wrap each registered Tasks component so Query and DB hooks read the shared cache. */
export function TasksDataRoot({ children }: { children: ReactNode }) {
  useTasksDataRoot();
  return <QueryClientProvider client={tasksQueryClient}>{children}</QueryClientProvider>;
}
