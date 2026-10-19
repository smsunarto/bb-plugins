import { defineMutation, type Context } from "@bb-kit/core/rpc";
import { z } from "zod";
import { reminderSchema, saveInput } from "../../shared/reminder.ts";
import type { ReminderStore } from "../lib/store.ts";

export const save = defineMutation({
  input: saveInput,
  output: z.object({ reminder: reminderSchema }),
  execute: ({ bb, store }: Context<{ store: ReminderStore }>, input) => {
    const reminder = store.save(input);
    bb.realtime.publish("reminders", { id: reminder.id });
    return { reminder };
  },
});
