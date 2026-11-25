import { cliCommand } from "@get-bb/plugin-sdk";
import {
  ASK_TEXT_MAX,
  captainComment,
  FULL_SHA,
  openAsk,
  shipBlockers,
  supersedeShipAsks,
} from "../asks.ts";
import { callerCaptain } from "../caller.ts";
import { resolveTask, tasksOrRefuse } from "../crew.ts";
import { guard, Refusal, render, type Blocker, type Item } from "../output.ts";
import { parseVerdictField, SHIP_READY_REVIEWS, VERDICT_FIELDS } from "../roles.ts";
import { TasksError } from "../tasks-client.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

/** Statuses a ship-ready review moves to `in_review`; later ones are left alone. */
const BEFORE_REVIEW: ReadonlySet<string> = new Set(["backlog", "todo", "in_progress"]);

export function verdictCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Record a review or triage verdict after checking the crew's report",
    positionals: [
      { name: "task", required: true, description: "The task key, such as PLUG-14" },
      { name: "role", required: true, description: "review or triage" },
      {
        name: "value",
        required: true,
        description:
          "review: findings, passed, skipped; triage: reproduced, not-reproduced, needs-info, duplicate, skipped",
      },
    ],
    options: {
      reason: {
        type: "string",
        placeholder: "why",
        description: "Required with skipped; posted on the task as a comment",
      },
      head: {
        type: "string",
        placeholder: "sha",
        description:
          "The commit the verdict judged, from the report; shipping compares the PR or branch head with it",
      },
      ship: {
        type: "boolean",
        description:
          "Also open the task's ship ask (Merge or Hold); needs review passed or skipped and the full --head",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain verdict", json, async () => {
        const captain = await callerCaptain(deps.bb, deps.registry, ctx, {
          captain: input.options.captain,
        });
        const { role, value: rawValue } = input.positionals;
        const value = rawValue.trim().toLowerCase();
        const reason = input.options.reason?.trim() || null;
        const rawHead = input.options.head?.trim() || null;
        const head = input.options.ship && rawHead !== null ? rawHead.toLowerCase() : rawHead;
        const field = parseVerdictField(role);
        const blockers: Blocker[] = [];
        if (field === null) {
          blockers.push({
            reason: `${JSON.stringify(role)} records no verdict`,
            fix: "pass review or triage",
          });
        } else if (!(VERDICT_FIELDS[field] as readonly string[]).includes(value)) {
          blockers.push({
            reason: `${JSON.stringify(rawValue)} is not a ${field} verdict`,
            fix: `pass one of ${VERDICT_FIELDS[field].join(", ")}`,
          });
        }
        if (value === "skipped" && reason === null) {
          blockers.push({
            reason: "a skipped verdict needs its reason",
            fix: `bb captain verdict ${input.positionals.task} ${role} skipped --reason "<why>"`,
          });
        }
        if (input.options.ship && field !== null && field !== "review") {
          blockers.push({ reason: "--ship follows a review verdict", fix: "drop --ship" });
        }
        if (input.options.ship && (head === null || !FULL_SHA.test(head))) {
          blockers.push({
            reason:
              head === null
                ? "--ship needs the head the review judged"
                : `--ship needs the full 40-character head, not ${JSON.stringify(rawHead)}`,
            fix: "pass --head <sha> with the full sha from the report, as git rev-parse HEAD prints it",
          });
        }
        const resolved = await tasksOrRefuse(() =>
          resolveTask(deps, captain, input.positionals.task),
        );
        if ("blocker" in resolved) blockers.push(resolved.blocker);
        if (input.options.ship && field === "review" && "task" in resolved) {
          blockers.push(...shipBlockers(resolved.task.key, value));
        }
        if (blockers.length > 0 || field === null || !("task" in resolved)) {
          throw new Refusal(blockers);
        }
        const { task } = resolved;

        await tasksOrRefuse(() => deps.fields.ensure());
        await tasksOrRefuse(() =>
          deps.tasks.setField({ taskId: task.id, key: field, value, head }),
        );
        const notes: string[] = [];
        const author = `${captain.name} Captain`;
        if (field === "review" && SHIP_READY_REVIEWS.has(value) && BEFORE_REVIEW.has(task.status)) {
          try {
            await deps.tasks.updateTaskStatus(task.id, "in_review", author);
          } catch (error) {
            if (!(error instanceof TasksError)) throw error;
            notes.push(`warning: ${task.key} not moved to in_review: ${error.message}`);
          }
        }
        if (reason !== null) {
          const body = `Verdict: ${field} ${value}${head === null ? "" : ` at ${head}`}. ${reason}`;
          // A rerun posts the reason once: look for this exact comment first.
          const posted = await deps.tasks
            .listComments(task.id)
            .then((comments) => comments.some((c) => c.body === body && c.authorName === author))
            .catch(() => false);
          if (!posted) {
            const warning = await captainComment(deps, captain, task.id, body);
            if (warning !== null) notes.push(`warning: ${warning}`);
          }
        }
        const items: Item[] = [
          {
            id: task.key,
            ok: true,
            state: "recorded",
            detail: `${field} ${value}${head === null ? "" : ` @${head}`}`,
            data: { field, value, head, reason },
          },
        ];
        if (field === "review") {
          notes.push(...(await supersedeShipAsks(deps, captain, task, { value, head })));
        }
        if (input.options.ship && head !== null) {
          const opened = await openAsk(deps, captain, {
            kind: "ship",
            task,
            text: shipText(task.key, task.title),
            detail: [
              `Review ${value} at ${head}.`,
              reason,
              "Merge lets the Captain ship it at that head: merge its PR, or fast-forward the target branch for a direct-ship repo. Hold keeps it open.",
            ]
              .filter((part) => part !== null)
              .join(" "),
            options: [],
          });
          items.push(opened.item);
          notes.push(...opened.notes);
        }
        return render(items, json, notes);
      });
    },
  });
}

/** `Merge PLUG-14: <title>`, cut to fit an ask's 80 characters. */
function shipText(key: string, title: string): string {
  const text = `Merge ${key}: ${title.replace(/\s+/gu, " ").trim()}`;
  return text.length <= ASK_TEXT_MAX ? text : `${text.slice(0, ASK_TEXT_MAX - 1).trimEnd()}…`;
}
