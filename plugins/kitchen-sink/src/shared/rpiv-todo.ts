import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const RPIV_TODO_CHANNEL = "rpiv-todos";
export const RPIV_TODO_EXPAND_SETTING = "rpivTodoExpandOnEnter";
export const todoSignalSchema = z.object({ threadId: z.string() });
export const todoSnapshotSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      activeForm: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed"]),
    }),
  ),
  truncated: z.boolean(),
});
export type TodoSnapshot = z.infer<typeof todoSnapshotSchema>;
export const rpivTodoContract = defineRpcContract({
  getRpivTodos: {
    input: z.strictObject({ threadId: z.string().min(1) }),
    output: todoSnapshotSchema,
  },
});
