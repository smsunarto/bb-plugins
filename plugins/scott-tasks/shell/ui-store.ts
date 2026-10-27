import { create } from "zustand";
import type { TaskStatus } from "../shared/contract.js";

export interface NewTaskRequest {
  projectId: string | null;
  status?: TaskStatus;
}

interface TasksUiState {
  /** A manual refresh is in flight; every surface's refresh control waits on it. */
  refreshing: boolean;
  /**
   * Bumps after each realtime batch, reconnect, or refresh settles. A live
   * query that failed retries on the next generation.
   */
  syncGeneration: number;
  /** The quick-create dialog's request, or null while it is closed. */
  newTask: NewTaskRequest | null;
  setRefreshing: (refreshing: boolean) => void;
  advanceSync: () => void;
  openNewTask: (request: NewTaskRequest) => void;
  closeNewTask: () => void;
}

const INITIAL_STATE = { refreshing: false, syncGeneration: 0, newTask: null };

/** Interaction state shared across Tasks surfaces. Remote data lives in Query and DB. */
export const useTasksUi = create<TasksUiState>()((set) => ({
  ...INITIAL_STATE,
  setRefreshing: (refreshing) => set({ refreshing }),
  advanceSync: () => set((state) => ({ syncGeneration: state.syncGeneration + 1 })),
  openNewTask: (request) => set({ newTask: request }),
  closeNewTask: () => set({ newTask: null }),
}));

export function resetTasksUiForTest(): void {
  useTasksUi.setState(INITIAL_STATE);
}
