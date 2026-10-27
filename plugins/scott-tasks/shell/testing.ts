import { resetTasksCollectionsForTest } from "./collections.js";
import { resetQuerySnapshotStateForTest } from "./query-snapshot.js";
import { setTasksRpc, tasksQueryClient } from "./query.js";
import { resetTasksSyncForTest } from "./sync.js";
import { resetTasksUiForTest } from "./ui-store.js";

/** Forget every cached read, row, and UI flag, so the next render starts cold. */
export async function resetTasksDataForTest(): Promise<void> {
  await tasksQueryClient.cancelQueries();
  resetTasksSyncForTest();
  await resetTasksCollectionsForTest();
  tasksQueryClient.clear();
  resetTasksUiForTest();
  resetQuerySnapshotStateForTest();
  setTasksRpc(null);
}
