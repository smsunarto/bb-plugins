import { cliCommand } from "@get-bb/plugin-sdk";
import { CAPTAINS_TAG } from "../../contract/rpc.ts";
import { actingFor } from "../caller.ts";
import { guard, render, type Item } from "../output.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";
import { refreshIcon } from "../icon.ts";

/** A page of crew per list call; the loop runs until a list comes back empty. */
const CREW_PAGE = 200;

export function archiveCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Release the crew with notifications off, then archive the Captain",
    options: { captain: CAPTAIN_OPTION, json: JSON_OPTION },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain archive", json, async () => {
        const address = input.options.captain?.trim();
        const done = address === undefined ? null : deps.store.captain(address);
        if (done !== null && done.archivedAt !== null) {
          return render(
            [{ id: done.threadId, ok: true, state: "archived", detail: done.name }],
            json,
          );
        }
        const { captain } = await actingFor(deps, ctx, { captain: address });
        const items = await releaseCrew(deps, captain.threadId);
        if (items.some((item) => !item.ok)) {
          items.push({
            id: captain.threadId,
            ok: false,
            state: "refused",
            blockers: [{ reason: "some crew were not released", fix: "bb captain archive" }],
          });
          return render(items, json);
        }
        const thread = await deps.bb.sdk.threads.get({ threadId: captain.threadId });
        if (thread.archivedAt === null)
          await deps.bb.sdk.threads.archive({ threadId: captain.threadId });
        deps.registry.archive(captain.threadId, deps.now());
        deps.bb.rpc.experimental_invalidate([CAPTAINS_TAG]);
        refreshIcon(deps, captain.threadId);
        items.push({ id: captain.threadId, ok: true, state: "archived", detail: captain.name });
        return render(items, json);
      });
    },
  });
}

/**
 * Clear the parent of every live child, with notifications off so releasing
 * wakes no one. Releasing first keeps bb's archive from cascading to the crew.
 */
async function releaseCrew(deps: CommandDeps, captainId: string): Promise<Item[]> {
  const items: Item[] = [];
  const tried = new Set<string>();
  for (;;) {
    const crew = await deps.bb.sdk.threads.list({
      parentThreadId: captainId,
      archived: false,
      includeHidden: true,
      limit: CREW_PAGE,
    });
    const fresh = crew.filter((thread) => !tried.has(thread.id));
    if (fresh.length === 0) return items;
    for (const thread of fresh) {
      tried.add(thread.id);
      try {
        await deps.bb.sdk.threads.update({
          threadId: thread.id,
          parentThreadId: null,
          parentNotifications: "off",
        });
        items.push({ id: thread.id, ok: true, state: "released" });
      } catch (error) {
        items.push({ id: thread.id, ok: false, state: "failed", detail: (error as Error).message });
      }
    }
  }
}
