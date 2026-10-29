import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import { newRuleId, ruleSchema, type Rule } from "../../shared/rules.ts";
import type { Target } from "../../shared/targets.ts";
import type { AgentInstructionsContext } from "../lib/store.ts";
import { describeConditions, loadTargets } from "../lib/targets.ts";

const scope = (noun: string) =>
  ({
    type: "string",
    repeatable: true,
    split: ",",
    description: `Only for this ${noun}: an id, a name, or "here" for the calling thread's`,
    placeholder: noun,
  }) as const;

/** The calling thread's own host, provider, and project, for `here`. */
async function here(ctx: AgentInstructionsContext, threadId: string | undefined) {
  if (!threadId) {
    throw new PluginCliError('"here" only works inside a bb thread', { code: "no_thread" });
  }
  const thread = await ctx.bb.sdk.threads.get({ threadId });
  const environment = thread.environmentId
    ? await ctx.bb.sdk.environments.get({ environmentId: thread.environmentId })
    : null;
  return { host: environment?.hostId, provider: thread.providerId, project: thread.projectId };
}

async function resolveAll(
  ctx: AgentInstructionsContext,
  threadId: string | undefined,
  noun: "host" | "provider" | "project",
  values: readonly string[] | undefined,
  known: readonly Target[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const value of values ?? []) {
    const named = known.filter((target) => target.name.toLowerCase() === value.toLowerCase());
    if (value !== "here" && !known.some((target) => target.id === value) && named.length > 1) {
      throw new PluginCliError(`${named.length} ${noun}s are named "${value}"`, {
        code: `ambiguous_${noun}`,
        hint: `Pass an id: ${named.map((target) => target.id).join(", ")}`,
      });
    }
    const id =
      value === "here"
        ? (await here(ctx, threadId))[noun]
        : (known.find((target) => target.id === value)?.id ?? named[0]?.id);
    if (!id) {
      const options = known.map((target) => `${target.name} (${target.id})`).join(", ");
      throw new PluginCliError(`Unknown ${noun} "${value}"`, {
        code: `unknown_${noun}`,
        hint: `Known: ${options}`,
      });
    }
    ids.push(id);
  }
  return [...new Set(ids)];
}

export function add(ctx: AgentInstructionsContext) {
  return cliCommand({
    summary: "Add an instruction rule, optionally scoped to hosts, providers, models, or projects",
    positionals: [
      { name: "text", description: "The instructions", required: true, variadic: true },
    ],
    options: {
      name: { type: "string", description: "A label for the rule", placeholder: "label" },
      host: scope("host"),
      provider: scope("provider"),
      project: scope("project"),
      model: {
        type: "string",
        repeatable: true,
        split: ",",
        description: "Only for models matching this glob, such as claude-opus-*",
        placeholder: "glob",
      },
    },
    async run({ positionals, options }, { threadId }) {
      const targets = await loadTargets(ctx.bb);
      const rule: Rule = ruleSchema.parse({
        id: newRuleId(),
        name: options.name ?? "",
        enabled: true,
        instructions: positionals.text.join(" "),
        when: {
          hosts: await resolveAll(ctx, threadId, "host", options.host, targets.hosts),
          providers: await resolveAll(
            ctx,
            threadId,
            "provider",
            options.provider,
            targets.providers,
          ),
          models: options.model ?? [],
          projects: await resolveAll(ctx, threadId, "project", options.project, targets.projects),
        },
      });
      await ctx.store.update((rules) => [...rules, rule]);
      return {
        exitCode: 0,
        stdout: `Added ${rule.id}, when ${describeConditions(rule.when, targets)}\n`,
      };
    },
  });
}
