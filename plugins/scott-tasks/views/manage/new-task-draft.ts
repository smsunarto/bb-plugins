import { z } from "zod";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/contract.js";

// Ported from upstream get-bb/bb#4100, with this fork's own storage key.
export const NEW_TASK_DRAFT_STORAGE_KEY = "scott-tasks:new-task-draft";
const NEW_TASK_DRAFT_VERSION = 1;

/** What the New task dialog keeps across dismissals. Staged files can't be serialized, so they are not kept. */
export interface NewTaskDraft {
  projectId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labelIds: string[];
  dueDate: string;
}

const storedDraftSchema = z.object({
  version: z.literal(NEW_TASK_DRAFT_VERSION),
  projectId: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(TASK_PRIORITIES),
  labelIds: z.array(z.string()),
  dueDate: z.string(),
});

export function hasDraftContent(draft: Pick<NewTaskDraft, "title" | "description">): boolean {
  return draft.title.trim() !== "" || draft.description.trim() !== "";
}

export function loadNewTaskDraft(): NewTaskDraft | null {
  try {
    const raw = window.localStorage.getItem(NEW_TASK_DRAFT_STORAGE_KEY);
    if (raw === null) return null;
    const parsed = storedDraftSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const { version: _version, ...draft } = parsed.data;
    return hasDraftContent(draft) ? draft : null;
  } catch {
    return null;
  }
}

/** Saves the draft, or forgets it once it has no title or description. */
export function storeNewTaskDraft(draft: NewTaskDraft): void {
  try {
    if (!hasDraftContent(draft)) {
      window.localStorage.removeItem(NEW_TASK_DRAFT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      NEW_TASK_DRAFT_STORAGE_KEY,
      JSON.stringify({ version: NEW_TASK_DRAFT_VERSION, ...draft }),
    );
  } catch {
    // Storage can be full or blocked; the dialog still works without a saved draft.
  }
}

export function clearNewTaskDraft(): void {
  try {
    window.localStorage.removeItem(NEW_TASK_DRAFT_STORAGE_KEY);
  } catch {
    // Same as above.
  }
}
