import { cliCommand } from "@get-bb/plugin-sdk";
import type { CatalogContext } from "../../catalog/import.ts";
import type { PublishReport } from "../../catalog/publish.ts";
import { MAX_INSTRUCTIONS_LENGTH, overflowingProviders, type Rule } from "../../shared/rules.ts";

const AGENTS_MD: Record<PublishReport["agentsMd"], string> = {
  linked: "published",
  relinked: "updated",
  unlinked: "removed",
  unchanged: "unchanged",
  none: "not published: no enabled global instructions",
  conflict: "not published: AGENTS.md is a file this plugin did not make",
};

/** What a publish found: clashes keep a skill or the global text from agents; warnings may not. */
export type PublishFindings = { problems: string[]; warnings: string[] };

export function publishFindings(report: PublishReport, rules: readonly Rule[]): PublishFindings {
  return {
    problems: report.conflicts.map(
      (c) => `${c} already exists and this plugin did not make it, so it was left alone`,
    ),
    // An upper bound: host, model, and project scope are ignored, so it is never a failure.
    warnings: overflowingProviders(rules).map(
      (o) =>
        `Rules for ${o.provider ?? "every provider"} add up to ${o.characters} characters if their host, model, and project scopes overlap; bb gives agents the first ${MAX_INSTRUCTIONS_LENGTH}`,
    ),
  };
}

export function publishLines(report: PublishReport, findings: PublishFindings): string[] {
  return [
    `Published skills: ${report.linked.length} added, ${report.relinked.length} updated, ${report.unlinked.length} removed, ${report.unchanged} unchanged`,
    `Global instructions: ${AGENTS_MD[report.agentsMd]}`,
    ...findings.problems.map((p) => `Problem: ${p}`),
    ...findings.warnings.map((w) => `Warning: ${w}`),
  ];
}

export function publishCommand(ctx: CatalogContext) {
  return cliCommand({
    summary: "Publish the catalog's skills and global instructions to bb's user tier",
    options: { json: { type: "boolean", description: "Print the result as JSON" } },
    async run({ options }) {
      const report = await ctx.publisher.run();
      const findings = publishFindings(report, ctx.store.state().rules);
      const stdout = options.json
        ? JSON.stringify({ ...report, ...findings }, null, 2)
        : publishLines(report, findings).join("\n");
      return { exitCode: findings.problems.length > 0 ? 1 : 0, stdout: `${stdout}\n` };
    },
  });
}
