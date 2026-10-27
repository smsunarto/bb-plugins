import { useQuery } from "@tanstack/react-query";
import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { useTasksDataRoot } from "./data-root.js";
import { openTaskCountQuery, tasksQueryClient } from "./query.js";

/** The nav panel badge runs as a hook slot, outside any component Tasks renders. */
export function useTasksBadge(): ExperimentalBadge | null {
  useTasksDataRoot();
  const { data: count } = useQuery(openTaskCountQuery, tasksQueryClient);
  if (count === undefined || count === 0) return null;
  return {
    count,
    label: count === 1 ? "1 open task" : `${count} open tasks`,
  };
}
