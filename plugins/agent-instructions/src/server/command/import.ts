import { cliCommand, PluginCliError } from "@get-bb/plugin-sdk";
import {
  commitImport,
  planImport,
  type CatalogContext,
  type ImportPlan,
  type ImportResult,
  type ImportSource,
} from "../../catalog/import.ts";
import type { PublishReport } from "../../catalog/publish.ts";
import { callerHost } from "../lib/targets.ts";
import { publishFindings, publishLines, type PublishFindings } from "./publish.ts";

const GLOBAL_KEY = "global-project";

/** The checkout to read: explicit flags, else the Global tab's project on a connected host. */
async function resolveSource(
  ctx: CatalogContext,
  threadId: string | undefined,
  options: { host?: string | undefined; root?: string | undefined },
): Promise<ImportSource> {
  const caller = await callerHost(ctx.bb, threadId);
  if (options.root) {
    const hostId = options.host ?? caller;
    if (!hostId)
      throw new PluginCliError("--root needs --host outside a bb thread", { code: "no_host" });
    return { hostId, rootPath: options.root };
  }
  const projectId = (await ctx.bb.storage.kv.get(GLOBAL_KEY)) as string | null | undefined;
  if (!projectId)
    throw new PluginCliError("Pass --root and --host to say which dotfiles checkout to read", {
      code: "no_source",
    });
  const [project, hosts] = await Promise.all([
    ctx.bb.sdk.projects.get({ projectId }),
    ctx.bb.sdk.hosts.list(),
  ]);
  const connected = new Set(hosts.filter((h) => h.status === "connected").map((h) => h.id));
  const sources = project.sources.filter(
    (s) => connected.has(s.hostId) && (!options.host || s.hostId === options.host),
  );
  const source =
    sources.find((s) => s.hostId === caller) ?? sources.find((s) => s.isDefault) ?? sources[0];
  if (!source)
    throw new PluginCliError(`${project.name} has no checkout on a connected host`, {
      code: "offline",
    });
  return { hostId: source.hostId, rootPath: source.path };
}

function parseRenames(pairs: readonly string[] | undefined): Map<string, string> {
  const renames = new Map<string, string>();
  for (const pair of pairs ?? []) {
    const [from, to, extra] = pair.split("=");
    if (!from || !to || extra !== undefined)
      throw new PluginCliError(`--rename ${pair}: expected from=to`, { code: "bad_rename" });
    renames.set(from, to);
  }
  return renames;
}

/** A stored import and what publishing it did, or why publishing failed. */
type Applied =
  | ({ result: ImportResult } & (
      | { published: PublishReport; findings: PublishFindings }
      | { published: null; error: string }
    ))
  | null;

function publishedJson(applied: NonNullable<Applied>) {
  return applied.published === null
    ? { error: applied.error }
    : { ...applied.published, ...applied.findings };
}

function planJson(plan: ImportPlan, applied: Applied) {
  return {
    source: plan.source,
    skills: plan.skills.map((s) => ({
      name: s.name,
      from: s.origin,
      files: s.files.length,
      treeSha: s.treeSha,
    })),
    docs: plan.docs.map((d) => ({ id: d.id, name: d.name, characters: d.body.length })),
    rules: plan.rules.map((r) => ({
      id: r.id,
      provider: r.provider,
      characters: r.instructions.length,
    })),
    renamed: plan.renamed,
    errors: plan.errors,
    warnings: plan.warnings,
    result: applied?.result ?? null,
    published: applied ? publishedJson(applied) : null,
  };
}

function outcomeLine(plan: ImportPlan, result: ImportResult | null): string {
  if (plan.errors.length > 0) return "Nothing stored: fix the errors above.";
  if (!result) return "Dry run: pass --apply to store this.";
  if (result.revision === null && result.rulesChanged.length === 0 && result.skipped.length === 0)
    return "Stored: nothing changed";
  const counts = `${result.added.length} added, ${result.updated.length} updated, ${result.removed.length} removed, ${result.unchanged} unchanged`;
  const stored = `Stored revision ${result.revision ?? "unchanged"}: ${counts}; docs ${result.docsChanged.length}; rules ${result.rulesChanged.length}`;
  return result.skipped.length > 0
    ? `${stored}\nKept as edited or deleted in bb: ${result.skipped.join(", ")}`
    : stored;
}

function publishText(applied: Applied): string[] {
  if (!applied) return [];
  if (applied.published === null) return [`Publish failed: ${applied.error}`];
  return publishLines(applied.published, applied.findings);
}

function planText(plan: ImportPlan, applied: Applied): string {
  const files = plan.skills.reduce((n, s) => n + s.files.length, 0);
  const bytes = plan.skills.reduce(
    (n, s) => n + s.files.reduce((m, f) => m + f.bytes.length, 0),
    0,
  );
  const docs = plan.docs.map((d) => `${d.name}, ${d.body.length} characters`).join("; ");
  const fragments = plan.rules
    .map((r) => `${r.provider} ${r.instructions.length} characters`)
    .join(", ");
  return [
    `Source: ${plan.source.rootPath} on ${plan.source.hostId}`,
    `Skills: ${plan.skills.length} (${files} files, ${(bytes / 1024).toFixed(0)} KiB)`,
    `Global instructions: ${docs || "none"}`,
    `Provider rules: ${fragments || "none"}`,
    ...plan.renamed.map((r) => `Renamed: ${r.from} -> ${r.to}`),
    ...plan.errors.map((e) => `Error: ${e}`),
    ...plan.warnings.map((w) => `Warning: ${w}`),
    outcomeLine(plan, applied?.result ?? null),
    ...publishText(applied),
  ].join("\n");
}

/** Stores the plan, then publishes it; a failed publish still reports the stored revision. */
async function applyImport(
  ctx: CatalogContext,
  plan: ImportPlan,
  threadId: string | undefined,
): Promise<NonNullable<Applied>> {
  const result = await commitImport(ctx, plan, threadId ?? "cli");
  try {
    const published = await ctx.publisher.run();
    return { result, published, findings: publishFindings(published, ctx.store.state().rules) };
  } catch (error) {
    return { result, published: null, error: (error as Error).message };
  }
}

export function importCommand(ctx: CatalogContext) {
  return cliCommand({
    summary: "Import skills and instructions from the dotfiles checkout into the catalog",
    options: {
      host: { type: "string", description: "Host that has the checkout", placeholder: "host-id" },
      root: {
        type: "string",
        description: "Path of the dotfiles checkout on that host",
        placeholder: "path",
      },
      rename: {
        type: "string",
        repeatable: true,
        description: "Store a skill under another name: name=new or plugin:name=new",
        placeholder: "from=to",
      },
      "allow-shadow": {
        type: "boolean",
        description: "Import a skill even if it hides a skill bb already delivers",
      },
      prune: {
        type: "boolean",
        description: "Remove imported skills, docs, and rules that the source no longer has",
      },
      apply: { type: "boolean", description: "Store the import; without it, only show the plan" },
      json: { type: "boolean", description: "Print the plan and result as JSON" },
    },
    async run({ options }, { threadId }) {
      const renames = parseRenames(options.rename);
      const source = await resolveSource(ctx, threadId, options);
      const plan = await planImport(ctx, source, {
        renames,
        allowShadow: options["allow-shadow"] ?? false,
        prune: options.prune ?? false,
      });
      const applied =
        options.apply && plan.errors.length === 0 ? await applyImport(ctx, plan, threadId) : null;
      const stdout = options.json
        ? JSON.stringify(planJson(plan, applied), null, 2)
        : planText(plan, applied);
      const failed =
        plan.errors.length > 0 ||
        applied?.published === null ||
        (applied?.findings.problems.length ?? 0) > 0;
      return { exitCode: failed ? 1 : 0, stdout: `${stdout}\n` };
    },
  });
}
