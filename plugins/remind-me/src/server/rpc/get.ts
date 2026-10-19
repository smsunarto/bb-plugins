import { defineQuery, type Context } from "@bb-kit/core/rpc";
import { z } from "zod";
import { reminderSchema } from "../../shared/reminder.ts";
import type { ReminderStore } from "../lib/store.ts";

export const get = defineQuery({
  input: z.object({ id: z.uuid() }).strict(),
  output: z.object({ reminder: reminderSchema.nullable() }),
  execute: ({ store }: Context<{ store: ReminderStore }>, { id }) => ({ reminder: store.get(id) }),
});
