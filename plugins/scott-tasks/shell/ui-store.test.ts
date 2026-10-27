import { QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { tasksQueryClient } from "./query.js";
import { refreshTasks } from "./sync.js";
import { useTasksUi } from "./ui-store.js";

describe("tasks UI store", () => {
  it("holds one quick-create request at a time", () => {
    const { openNewTask, closeNewTask } = useTasksUi.getState();
    openNewTask({ projectId: "p1", status: "todo" });
    openNewTask({ projectId: "p2" });
    expect(useTasksUi.getState().newTask).toEqual({ projectId: "p2" });
    closeNewTask();
    expect(useTasksUi.getState().newTask).toBeNull();
  });

  it("runs one manual refresh at a time and advances the sync generation when it settles", async () => {
    let reads = 0;
    let release: (() => void) | undefined;
    const observer = new QueryObserver(tasksQueryClient, {
      queryKey: ["projects"],
      queryFn: async () => {
        reads += 1;
        if (reads > 1) await new Promise<void>((resolve) => (release = resolve));
        return [];
      },
    });
    const unsubscribe = observer.subscribe(() => {});
    await expect.poll(() => reads).toBe(1);
    const generation = useTasksUi.getState().syncGeneration;

    refreshTasks();
    refreshTasks();
    expect(useTasksUi.getState().refreshing).toBe(true);
    await expect.poll(() => reads).toBe(2);
    release?.();
    await expect.poll(() => useTasksUi.getState().refreshing).toBe(false);
    expect(reads).toBe(2);
    expect(useTasksUi.getState().syncGeneration).toBe(generation + 1);
    unsubscribe();
  });
});
