import { defineQuery, type Context } from "@bb-kit/core/rpc";
import { z } from "zod";
import { reminderSchema } from "../../shared/reminder.ts";
import type { ReminderStore } from "../lib/store.ts";

export const list = defineQuery({
  output: z.object({ reminders: z.array(reminderSchema) }),
  execute: ({ store }: Context<{ store: ReminderStore }>) => ({ reminders: store.list() }),
});
