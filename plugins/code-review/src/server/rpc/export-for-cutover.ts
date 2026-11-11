import { z } from "zod";
import type { CodeReviewContext } from "../lib/context.ts";

/**
 * Everything this plugin keeps in its own storage that a user would miss
 * after the cutover to Source Control, as stored. Read-only: it deletes and
 * changes nothing, so the old plugin keeps working after an export and a
 * rollback finds its data where it was. Source Control's `import` calls it;
 * storage is per plugin id, so this is the only way across.
 */
export const exportForCutoverContract = {
  input: z.strictObject({}),
  output: z.strictObject({
    version: z.literal(1),
    pins: z.unknown(),
    instructions: z.unknown(),
    /** `reviewed:<branchId>` local-branch viewed marks, each with its `branch-location:<branchId>`. */
    reviewed: z.array(
      z.strictObject({ branchId: z.string(), value: z.unknown(), location: z.unknown() }),
    ),
    /** `watch:<threadId>:<pr key>` records. */
    watches: z.array(z.strictObject({ key: z.string(), value: z.unknown() })),
    /** `landed:<threadId>` records. */
    landed: z.array(z.strictObject({ threadId: z.string(), value: z.unknown() })),
    /** Review runs and thread links, counted: they stay readable in their threads. */
    counts: z.strictObject({ runs: z.number(), links: z.number(), threads: z.number() }),
  }),
};

export async function exportForCutover(ctx: CodeReviewContext) {
  const kv = ctx.bb.storage.kv;
  const keys = await kv.list("");
  const values = async (prefix: string) =>
    Promise.all(
      keys
        .filter((key) => key.startsWith(prefix))
        .map(async (key) => ({ key, value: await kv.get<unknown>(key) })),
    );
  const [reviewed, watches, landed] = await Promise.all([
    values("reviewed:"),
    values("watch:"),
    values("landed:"),
  ]);
  return {
    version: 1 as const,
    pins: (await kv.get<unknown>("pins")) ?? [],
    instructions: (await kv.get<unknown>("instructions")) ?? null,
    reviewed: await Promise.all(
      reviewed.map(async ({ key, value }) => {
        const branchId = key.slice("reviewed:".length);
        return {
          branchId,
          value,
          location: (await kv.get<unknown>(`branch-location:${branchId}`)) ?? null,
        };
      }),
    ),
    watches,
    landed: landed.map(({ key, value }) => ({ threadId: key.slice("landed:".length), value })),
    counts: {
      runs: keys.filter((key) => key.startsWith("run:")).length,
      links: keys.filter((key) => key.startsWith("links:")).length,
      threads: keys.filter((key) => key.startsWith("thread:")).length,
    },
  };
}
