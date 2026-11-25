import { cliCommand } from "@get-bb/plugin-sdk";
import { actingFor } from "../caller.ts";
import {
  joinCrew,
  listChildren,
  readInteractions,
  tasksOrRefuse,
  type CrewThread,
} from "../crew.ts";
import { guard, Refusal } from "../output.ts";
import { countsLine, decodeCursor, deriveStatus, rowLine } from "../status.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

export function statusCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "The rows that need action and a counts line; --since only what changed",
    options: {
      since: {
        type: "string",
        placeholder: "cursor",
        description:
          "Only rows whose sources changed after this cursor, plus every stalled, blocked and health row",
      },
      all: { type: "boolean", description: "Every row, archived crew included" },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain status", json, async () => {
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
        });
        let since: number | null = null;
        if (input.options.since !== undefined) {
          since = decodeCursor(input.options.since);
          if (since === null) {
            throw new Refusal([
              {
                reason: `${JSON.stringify(input.options.since)} is not a status cursor`,
                fix: "pass the cursor a previous bb captain status printed, such as c_815",
              },
            ]);
          }
        }
        const all = input.options.all;
        // Step 1, the Captain's own thread for its health row, and step 4's
        // archived children only for --all.
        const [live, archived, own] = await Promise.all([
          listChildren(deps.bb, captain.threadId, false),
          all ? listChildren(deps.bb, captain.threadId, true) : Promise.resolve([]),
          deps.bb.sdk.threads.get({ threadId: captain.threadId }).catch(() => null),
        ]);
        // Every thread this Captain ever ran, so a ready task outlives its archived crew.
        const ids = new Set([
          ...live.map((thread) => thread.id),
          ...archived.map((thread) => thread.id),
          ...deps.store.crewRolesOf(captain.threadId).map((crew) => crew.threadId),
        ]);
        // Steps 2 and 3 in parallel: one crewSnapshot, interactions only for blocked crew.
        const [rows, interactions] = await Promise.all([
          tasksOrRefuse(() => deps.tasks.crewSnapshot([...ids])),
          readInteractions(
            deps,
            live.filter((thread) => thread.hasPendingInteraction).map((thread) => thread.id),
          ),
        ]);
        const crew: CrewThread[] = joinCrew(deps, live, rows);
        const status = deriveStatus({
          now: deps.now(),
          captain: own,
          crew,
          archived: joinCrew(deps, archived, rows),
          interactions,
          asks: deps.store.asksOf(captain.threadId),
          taskRows: rows,
          since,
          all,
        });
        if (json) {
          return {
            exitCode: 0,
            stdout: `${JSON.stringify({ ok: true, cursor: status.cursor, counts: status.counts, rows: status.rows })}\n`,
          };
        }
        const now = deps.now();
        const lines = [countsLine(status), ...status.rows.map((row) => rowLine(row, now))];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      });
    },
  });
}
