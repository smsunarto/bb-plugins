import { cliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import {
  ASK_OPTION_COLUMNS,
  askBlockers,
  askItem,
  openAsk,
  resolveAsk,
  shipBlockers,
} from "../asks.ts";
import { callerCaptain, readCallerFile } from "../caller.ts";
import { resolveTask, taskFields, tasksOrRefuse } from "../crew.ts";
import { guard, Refusal, render, type Blocker } from "../output.ts";
import { ASK_KINDS, type AskKind } from "../../contract/queue.ts";
import type { TasksTask } from "../tasks-client.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

export function askCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Open an ask: a decision for the user, answered with one click",
    positionals: [
      {
        name: "text",
        required: true,
        description: 'One imperative line of at most 80 characters, such as "Merge PLUG-14"',
      },
    ],
    options: {
      kind: {
        type: "enum",
        values: ASK_KINDS,
        default: "decision",
        description: "decision, ship, access or improve",
      },
      task: {
        type: "string",
        placeholder: "key",
        description: "The task it blocks; required for decision and ship asks",
      },
      option: {
        type: "string",
        repeatable: true,
        placeholder: "answer",
        description: `A button label of ≤${ASK_OPTION_COLUMNS} columns (wide characters count 2) with no ⭐ or other marker, the recommended one first; repeat it. A decision ask needs two or more; a ship ask takes none (Merge and Hold)`,
      },
      detail: {
        type: "string",
        stdin: true,
        placeholder: "text",
        description: "What is blocked and why you recommend the first option",
      },
      "detail-file": {
        type: "string",
        placeholder: "path",
        description: "Read the detail from this UTF-8 file on the invoking machine",
      },
      captain: CAPTAIN_OPTION,
      json: JSON_OPTION,
    },
    constraints: [{ kind: "exactly-one", options: ["detail", "detail-file"] }],
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain ask", json, async () => {
        const captain = await callerCaptain(deps.bb, deps.registry, ctx, {
          captain: input.options.captain,
        });
        const kind = input.options.kind as AskKind;
        const detail = await textOption(
          deps,
          ctx,
          input.options.detail,
          input.options["detail-file"],
          "--detail-stdin",
        );
        const taskKey = input.options.task?.trim().toUpperCase() || null;
        const blockers: Blocker[] = askBlockers({
          kind,
          taskKey,
          text: input.positionals.text,
          detail,
          options: input.options.option,
        });
        let task: TasksTask | null = null;
        if (taskKey !== null) {
          const resolved = await tasksOrRefuse(() => resolveTask(deps, captain, taskKey));
          if ("blocker" in resolved) blockers.push(resolved.blocker);
          else task = resolved.task;
        }
        if (kind === "ship" && task !== null) {
          const fields = await tasksOrRefuse(() => taskFields(deps, task));
          blockers.push(...shipBlockers(task.key, fields.get("review")?.value ?? null));
        }
        if (blockers.length > 0) throw new Refusal(blockers);
        const { item, notes } = await openAsk(deps, captain, {
          kind,
          task,
          text: input.positionals.text,
          detail,
          options: input.options.option,
        });
        return render([item], json, notes);
      });
    },
  });
}

export function askResolveCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Answer an ask; the answer is posted on its task and sent to the Captain",
    positionals: [{ name: "id", required: true, description: "The ask id, such as a7" }],
    options: {
      answer: {
        type: "string",
        required: true,
        placeholder: "words",
        description: "The answer, usually one of the ask's options",
      },
      json: JSON_OPTION,
    },
    run(input) {
      const json = input.options.json;
      return guard("captain ask resolve", json, async () => {
        const { ask, state, notes } = await resolveAsk(
          deps,
          input.positionals.id,
          input.options.answer,
        );
        return render([askItem(ask, state)], json, notes);
      });
    },
  });
}

/** An inline text option or a file on the invoking machine; `-` is not stdin here. */
export async function textOption(
  deps: CommandDeps,
  ctx: PluginCliContext,
  inline: string | undefined,
  file: string | undefined,
  stdinFlag: string,
): Promise<string> {
  if (file === undefined) return inline ?? "";
  if (file.trim() === "-") {
    throw new Refusal([
      {
        reason: "a file option cannot read stdin here",
        fix: `write the text to a file and pass its path; ${stdinFlag} takes one line only`,
      },
    ]);
  }
  return await readCallerFile(deps.bb, ctx, file);
}
