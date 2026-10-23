export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
}

export interface TaskState {
  tasks: Task[];
  nextId: number;
}

export interface TodoItem {
  id: string;
  text: string;
  activeForm?: string;
  status: Exclude<TaskStatus, "deleted">;
}

export const TODO_TEXT_MAX_LENGTH = 240;

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };
