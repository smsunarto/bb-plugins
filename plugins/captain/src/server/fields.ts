import { VERDICT_FIELDS } from "./roles.ts";
import type { TasksClient } from "./tasks-client.ts";

export type Fields = ReturnType<typeof createFields>;

/**
 * Define Captain's owned verdict fields in Tasks. `defineField` is idempotent,
 * so the plugin calls it at startup and `verdict` calls it again until one run
 * succeeds, which covers Tasks loading after Captain.
 */
export function createFields(tasks: Pick<TasksClient, "defineField">) {
  let defined: Promise<void> | null = null;
  return {
    ensure(): Promise<void> {
      if (defined === null) {
        const attempt = (async () => {
          for (const [key, values] of Object.entries(VERDICT_FIELDS)) {
            await tasks.defineField(key, values);
          }
        })();
        defined = attempt;
        attempt.catch(() => {
          if (defined === attempt) defined = null;
        });
      }
      return defined;
    },
  };
}
