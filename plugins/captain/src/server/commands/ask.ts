import { cliCommand, type PluginCliContext } from "@get-bb/plugin-sdk";
import {
  ASK_OPTION_COLUMNS,
  askBlockers,
  askItem,
  askOrRefuse,
  openAsk,
  optionLabelBlockers,
  resolveAsk,
} from "../asks.ts";
import { actingFor, readCallerFile } from "../caller.ts";
import { resolveTask, tasksBlocker } from "../crew.ts";
import { guard, Refusal, render } from "../output.ts";
import { ASK_KINDS, type AskKind } from "../../contract/queue.ts";
import { TasksError } from "../tasks-client.ts";
import { CAPTAIN_OPTION, JSON_OPTION, type CommandDeps } from "./deps.ts";

export function askCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Open an ask: a decision for the user, answered with one click",
    positionals: [
      {
        name: "text",
        required: true,
        description:
          'One imperative line of at most 80 characters, such as "Pick the Unity account for cloud crew"',
      },
    ],
    options: {
      kind: {
        type: "enum",
        values: ASK_KINDS,
        default: "decision",
        description:
          "decision, access or improve; a ship ask opens only through bb captain verdict --ship",
      },
      task: {
        type: "string",
        placeholder: "key",
        description: "The task it blocks; required for decision asks",
      },
      option: {
        type: "string",
        repeatable: true,
        placeholder: "answer",
        description: `A button label of ≤${ASK_OPTION_COLUMNS} columns (wide characters count 2) with no ⭐ or other marker, the recommended one first; repeat it. A decision ask needs two or more`,
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
        const { captain } = await actingFor(deps, ctx, {
          captain: input.options.captain,
        });
        const kind = input.options.kind as AskKind;
        if (kind === "ship") {
          // A ship ask must name the head its review judged, which only verdict records.
          const key = input.options.task?.trim().toUpperCase() || "<task>";
          throw new Refusal([
            {
              reason: "a ship ask opens only with the review verdict that names its head",
              fix: `once Review has passed: bb captain verdict ${key} review passed --head <sha> --ship`,
            },
          ]);
        }
        const detail = await textOption(
          deps,
          ctx,
          input.options.detail,
          input.options["detail-file"],
          "--detail-stdin",
        );
        const taskKey = input.options.task?.trim().toUpperCase() || null;
        const resolved =
          taskKey === null
            ? { task: null }
            : await resolveTask(deps, captain, taskKey).catch((error: unknown) => {
                if (error instanceof TasksError) return { blocker: tasksBlocker(error) };
                throw error;
              });
        const task = "task" in resolved ? resolved.task : null;
        const text = input.positionals.text.trim();
        const options = input.options.option.map((option) => option.trim());
        const existing =
          "task" in resolved
            ? deps.store.findOpenAsk(captain.threadId, kind, task?.key ?? null, text)
            : null;
        const draft = { kind, task, text, detail, options };
        const blockers = askBlockers({ ...draft, taskKey }, existing?.options);
        if ("blocker" in resolved) blockers.push(resolved.blocker);
        if (blockers.length > 0) {
          if (existing === null) blockers.push(...optionLabelBlockers(options));
          throw new Refusal(blockers);
        }
        const { item, notes } = await openAsk(deps, captain, draft);
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
    run(input, ctx) {
      const json = input.options.json;
      return guard("captain ask resolve", json, async () => {
        const { ask, state, notes } = await resolveAsk(
          deps,
          input.positionals.id,
          input.options.answer,
          ctx.threadId ?? null,
        );
        return render([askItem(ask, state)], json, notes);
      });
    },
  });
}

export function askShowCommand(deps: CommandDeps) {
  return cliCommand({
    summary: "Print one ask's record: its kind, task, detail, answer and who answered it",
    positionals: [{ name: "id", required: true, description: "The ask id, such as a7" }],
    options: { json: JSON_OPTION },
    run(input) {
      const json = input.options.json;
      return guard("captain ask show", json, async () => {
        const ask = askOrRefuse(deps.store, input.positionals.id);
        const item = askItem(ask, ask.answer === null ? "open" : "answered");
        const by = ask.answer === null ? null : `by ${ask.answeredBy ?? "unknown"}`;
        return render(
          [
            {
              ...item,
              detail: [item.detail, by].filter((part) => part !== null).join("  "),
              data: { ...item.data, detail: ask.detail, answeredAt: ask.answeredAt },
            },
          ],
          json,
        );
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
