import { createHash } from "node:crypto";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { hostContract } from "../host-contract.ts";
import type { RuleStore } from "../server/lib/store.ts";
import { MAX_INSTRUCTIONS_LENGTH, type Rule } from "../shared/rules.ts";
import { textFilePattern } from "../shared/text-files.ts";
import { DOTFILES_AGENTS } from "./model.ts";
import type { Publisher } from "./publish.ts";
import {
  MAX_SKILL_FILES,
  parseFrontmatter,
  pathProblems,
  relativeLinks,
  relinkSkills,
  renameFrontmatter,
  rewriteNamespaced,
  SKILL_NAME_PATTERN,
} from "./skill-rules.ts";
import {
  treeSha,
  type CatalogDoc,
  type CatalogSkill,
  type CatalogStore,
  type ImportChanges,
} from "./store.ts";

export type CatalogContext = Readonly<{
  bb: BbPluginApi;
  store: RuleStore;
  catalog: CatalogStore;
  host: ExperimentalHostClient<typeof hostContract>;
  publisher: Publisher;
}>;

export type ImportSource = { hostId: string; rootPath: string };
export type ImportOptions = {
  /** `name` or `plugin:name` mapped to a new catalog name. */
  renames: ReadonlyMap<string, string>;
  /** Report shadowing of a bb-delivered skill, or an unavailable check, as a warning instead of an error. */
  allowShadow: boolean;
  /** Allow removing imported skills, docs, and rules that the source no longer has. */
  prune: boolean;
};

/** A provider-specific instruction fragment, imported as a scoped rule. */
export type ImportedRule = { id: string; name: string; instructions: string; provider: string };

export type ImportPlan = {
  source: ImportSource;
  skills: CatalogSkill[];
  docs: CatalogDoc[];
  rules: ImportedRule[];
  renamed: { from: string; to: string }[];
  errors: string[];
  warnings: string[];
};

/** Instruction fragments that apply to one provider, keyed by file name. */
const PROVIDER_FRAGMENTS: Record<string, string> = {
  "claude.md": "claude-code",
  "codex.md": "codex",
};
const GLOBAL_FILE = "shared.md";
/** Rules the importer owns; any other rule is authored and never touched. */
const IMPORTED_RULE_PREFIX = "rule_import_";

type SourceTree = {
  dir: string;
  plugin: string | null;
  files: { path: string; executable: boolean; base64: string }[];
  symlinks: string[];
  tooLarge: boolean;
};
type Entry = SourceTree & { label: string; original: string; name: string; description: string };
/** Collected while planning; every check appends here instead of throwing. */
type Report = { errors: string[]; warnings: string[] };
/** How `plugin:skill` references in text map to flat catalog names. */
type References = {
  names: Map<string, string>;
  plugins: Set<string>;
  siblings: Set<string>;
  /** Source folder of each skill, mapped to its catalog name. */
  dirs: Map<string, string>;
  /** `plugin:*` references found, which have no flat equivalent. */
  groups: Set<string>;
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

function decodeText(path: string, bytes: Buffer): string | null {
  if (!textFilePattern.test(path)) return null;
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** Names bb already delivers from plugins or its built-ins, with their owner. */
async function deliveredSkills(bb: BbPluginApi, report: Report, allowShadow: boolean) {
  try {
    // Plugin and built-in skills are the same in every project; any project can list them.
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const project = projects.find((p) => p.kind === "personal") ?? projects[0];
    if (!project) throw new Error("bb has no project to list skills in");
    const { skills } = await bb.sdk.skills.list({ projectId: project.id, environmentId: null });
    const owners = new Map<string, string>();
    const user = new Set<string>();
    for (const skill of skills) {
      if (skill.provider !== null) continue;
      const name = skill.name.split(":").pop()!;
      if (skill.scope === "plugin") owners.set(name, `plugin ${skill.pluginId ?? "unknown"}`);
      else if (skill.scope === "bb-builtin") owners.set(name, "bb's built-in skills");
      else if (skill.scope === "bb-user") user.add(name);
    }
    return { owners, user };
  } catch (error) {
    (allowShadow ? report.warnings : report.errors).push(
      `Could not check for skills bb already delivers (${(error as Error).message}); pass --allow-shadow to import without the check`,
    );
    return { owners: new Map<string, string>(), user: new Set<string>() };
  }
}

/** Checks one source skill folder and resolves its catalog name; null when it cannot be imported. */
function checkTree(
  tree: SourceTree,
  renames: ReadonlyMap<string, string>,
  usedRenames: Set<string>,
  report: Report,
): Entry | null {
  const folder = tree.dir.split("/").pop()!;
  const label = tree.plugin ? `${tree.plugin}:${folder}` : folder;
  if (tree.tooLarge) {
    report.errors.push(`${label}: larger than one import call allows; split its assets out`);
    return null;
  }
  if (tree.symlinks.length > 0)
    report.errors.push(
      `${label}: contains links (${tree.symlinks.join(", ")}); bb refuses linked files inside a skill`,
    );
  if (tree.files.length > MAX_SKILL_FILES)
    report.errors.push(
      `${label}: ${tree.files.length} files; bb accepts at most ${MAX_SKILL_FILES}`,
    );
  const skillFile = tree.files.find((f) => f.path === "SKILL.md");
  if (!skillFile) {
    report.errors.push(`${label}: no SKILL.md`);
    return null;
  }
  const frontmatter = parseFrontmatter(Buffer.from(skillFile.base64, "base64").toString("utf8"));
  if ("error" in frontmatter) {
    report.errors.push(`${label}: ${frontmatter.error}`);
    return null;
  }
  const original = frontmatter.name;
  // Errors name a skill by its folder label, so that key works as well as its declared name.
  const keys = [label, tree.plugin ? `${tree.plugin}:${original}` : original, folder, original];
  const key = keys.find((k) => renames.has(k));
  if (key) usedRenames.add(key);
  const name = key ? renames.get(key)! : original;
  if (!SKILL_NAME_PATTERN.test(name)) {
    report.errors.push(
      `${label}: rename target ${JSON.stringify(name)} is not a valid bb skill name`,
    );
    return null;
  }
  return { ...tree, label, original, name, description: frontmatter.description };
}

function duplicateNames(entries: readonly Entry[], report: Report) {
  const byName = new Map<string, Entry[]>();
  for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  for (const [name, group] of byName)
    if (group.length > 1)
      report.errors.push(
        `${group.map((e) => e.label).join(" and ")} would both be named ${name}; rename one`,
      );
}

function references(entries: readonly Entry[]): References {
  const names = new Map<string, string>();
  const plugins = new Set<string>();
  for (const e of entries) {
    if (!e.plugin) continue;
    plugins.add(e.plugin);
    names.set(`${e.plugin}:${e.original}`, e.name);
    names.set(`${e.plugin}:${e.dir.split("/").pop()!}`, e.name);
  }
  return {
    names,
    plugins,
    siblings: new Set(entries.map((e) => e.name)),
    dirs: new Map(entries.map((e) => [e.dir, e.name])),
    groups: new Set(),
  };
}

/** Flattens `plugin:skill` references and records `plugin:*` groups. */
function flatten(text: string, refs: References): string {
  const rewritten = rewriteNamespaced(text, refs.names, refs.plugins);
  for (const group of rewritten.groups) refs.groups.add(group);
  return rewritten.text;
}

/** Rewrites a skill's text files for the catalog and hashes every file. */
function catalogFiles(e: Entry, refs: References, report: Report): CatalogSkill["files"] {
  return e.files.map((file) => {
    let bytes = Buffer.from(file.base64, "base64");
    const text = decodeText(file.path, bytes);
    if (text !== null) {
      let content = relinkSkills(
        { dir: e.dir, name: e.name, path: file.path },
        flatten(text, refs),
        refs.dirs,
      );
      if (file.path === "SKILL.md" && e.name !== e.original)
        content = renameFrontmatter(content, e.original, e.name);
      for (const problem of pathProblems(file.path, content, refs.siblings))
        report.errors.push(`${e.label}: ${problem}`);
      bytes = Buffer.from(content, "utf8");
    }
    return { path: file.path, executable: file.executable, sha256: sha256(bytes), bytes };
  });
}

/**
 * Re-reads the rewritten SKILL.md: it must still declare the catalog name, and
 * its description, with references flattened, is the one agents will see.
 */
function publishedDescription(e: Entry, files: CatalogSkill["files"], report: Report): string {
  const skillFile = files.find((f) => f.path === "SKILL.md")!;
  const parsed = parseFrontmatter(Buffer.from(skillFile.bytes).toString("utf8"));
  if ("error" in parsed) {
    report.errors.push(`${e.label}: after rewriting, ${parsed.error}`);
    return e.description;
  }
  if (parsed.name !== e.name)
    report.errors.push(
      `${e.label}: SKILL.md still declares ${parsed.name}; the rename could not rewrite it, so set name: ${e.name} by hand`,
    );
  return parsed.description;
}

/** Reads the instruction fragments: `shared.md` becomes global text, provider files become rules. */
async function planInstructions(
  ctx: CatalogContext,
  source: ImportSource,
  files: readonly string[],
  refs: References,
  report: Report,
) {
  const docs: CatalogDoc[] = [];
  const rules: ImportedRule[] = [];
  for (const file of files) {
    const path = `${DOTFILES_AGENTS}/instructions/${file}`;
    const { content } = await ctx.host.call(
      "readText",
      { rootPath: source.rootPath, path },
      { hostId: source.hostId, timeoutMs: 60_000 },
    );
    if (content === null) continue;
    const body = flatten(content, refs).trim();
    const provider = PROVIDER_FRAGMENTS[file];
    for (const link of new Set(relativeLinks(body)))
      report.warnings.push(
        `${path}: links to ${link}, which will not resolve once this text is delivered on its own`,
      );
    if (file === GLOBAL_FILE) {
      docs.push({
        id: "imported:shared",
        name: "Global instructions",
        body,
        origin: { kind: "imported", from: path },
      });
    } else if (provider) {
      if (body.length > MAX_INSTRUCTIONS_LENGTH)
        report.errors.push(
          `${path}: ${body.length} characters; a provider fragment must fit ${MAX_INSTRUCTIONS_LENGTH}`,
        );
      const stem = file.replace(/\.md$/, "");
      rules.push({
        id: `rule_import_${stem}`,
        name: `Imported ${stem}.md`,
        instructions: body,
        provider,
      });
    } else report.warnings.push(`${path}: no provider is known for this fragment; skipped`);
  }
  return { docs, rules };
}

/**
 * Imported entries the source no longer has. Removing them needs --prune, so a
 * wrong --root or a half-checked-out tree cannot empty the catalog.
 */
function checkRemovals(
  ctx: CatalogContext,
  incoming: Pick<ImportPlan, "skills" | "docs" | "rules">,
  catalogSkills: ReturnType<CatalogStore["skills"]>,
  prune: boolean,
  report: Report,
) {
  const skills = new Set(incoming.skills.map((s) => s.name));
  const docs = new Set(incoming.docs.map((d) => d.id));
  const rules = new Set(incoming.rules.map((r) => r.id));
  const gone = [
    ...catalogSkills
      .filter((s) => s.origin.kind === "imported" && !skills.has(s.name))
      .map((s) => `skill ${s.name}`),
    ...ctx.catalog
      .docs()
      .filter((d) => d.origin.kind === "imported" && !docs.has(d.id))
      .map((d) => `doc ${d.id}`),
    ...ctx.store
      .state()
      .rules.filter((r) => r.id.startsWith(IMPORTED_RULE_PREFIX) && !rules.has(r.id))
      .map((r) => `rule ${r.id}`),
  ];
  if (gone.length === 0) return;
  const list = gone.join(", ");
  if (prune) report.warnings.push(`Removes what the source no longer has: ${list}`);
  else
    report.errors.push(
      `The source no longer has ${list}; pass --prune to remove them, or check --root`,
    );
}

/** Reads the dotfiles sources on their host and checks them. Writes nothing. */
export async function planImport(
  ctx: CatalogContext,
  source: ImportSource,
  options: ImportOptions,
): Promise<ImportPlan> {
  const call = { hostId: source.hostId, timeoutMs: 60_000 };
  const report: Report = { errors: [], warnings: [] };
  const listing = await ctx.host.call("listAgentSources", { rootPath: source.rootPath }, call);
  for (const link of listing.links)
    report.errors.push(
      `${link}: is a link; the importer does not follow links, so replace it with the real folder or file`,
    );
  if (listing.skills.length === 0 && listing.instructions.length === 0)
    report.errors.push(
      `No ${DOTFILES_AGENTS}/{instructions,skills,plugins} found under ${source.rootPath}.`,
    );

  const trees = await mapLimit(listing.skills, 4, async (entry) => ({
    ...entry,
    ...(await ctx.host.call("readSkillTree", { rootPath: source.rootPath, dir: entry.dir }, call)),
  }));
  const usedRenames = new Set<string>();
  const entries = trees.flatMap(
    (tree) => checkTree(tree, options.renames, usedRenames, report) ?? [],
  );
  for (const key of options.renames.keys())
    if (!usedRenames.has(key)) report.warnings.push(`--rename ${key}: no skill has that name`);
  duplicateNames(entries, report);
  const refs = references(entries);

  const delivered = await deliveredSkills(ctx.bb, report, options.allowShadow);
  const authored = ctx.catalog.authoredNames();
  const catalogSkills = ctx.catalog.skills();
  const stored = new Set(catalogSkills.map((s) => s.name));
  const skills = entries.map((e): CatalogSkill => {
    const owner = delivered.owners.get(e.name);
    if (owner)
      (options.allowShadow ? report.warnings : report.errors).push(
        `${e.label}: would hide the ${e.name} skill from ${owner}; pass --rename ${e.label}=<new-name>`,
      );
    if (delivered.user.has(e.name) && !stored.has(e.name))
      report.warnings.push(
        `${e.label}: bb already has a user skill named ${e.name}; publishing will leave it alone`,
      );
    if (authored.has(e.name))
      report.errors.push(`${e.label}: an authored catalog skill is already named ${e.name}`);
    const files = catalogFiles(e, refs, report);
    return {
      name: e.name,
      description: publishedDescription(e, files, report),
      origin: { kind: "imported", from: e.dir },
      files,
      treeSha: treeSha(files),
    };
  });

  const { docs, rules } = await planInstructions(ctx, source, listing.instructions, refs, report);
  for (const group of refs.groups)
    report.warnings.push(
      `${group} names a whole plugin; flat skill names have no equivalent, so rewrite that sentence`,
    );

  checkRemovals(ctx, { skills, docs, rules }, catalogSkills, options.prune, report);

  const renamed = entries
    .filter((e) => e.name !== e.original)
    .map((e) => ({ from: e.label, to: e.name }));
  return { source, skills, docs, rules, renamed, ...report };
}

export type ImportResult = ImportChanges & { rulesChanged: string[] };

/** The stored form of an imported rule; a user's name, enabled flag, and extra scoping survive. */
function importedRule(imported: ImportedRule, previous: Rule | undefined): Rule {
  return {
    id: imported.id,
    name: previous?.name ?? imported.name,
    enabled: previous?.enabled ?? true,
    instructions: imported.instructions,
    when: {
      hosts: previous?.when.hosts ?? [],
      providers: [imported.provider],
      models: previous?.when.models ?? [],
      projects: previous?.when.projects ?? [],
    },
  };
}

/** Stores a plan that has no errors: catalog first, then the provider rules. */
export async function commitImport(
  ctx: CatalogContext,
  plan: ImportPlan,
  actor: string,
): Promise<ImportResult> {
  if (plan.errors.length > 0) throw new Error("The import plan has errors; nothing was stored.");
  const changes = ctx.catalog.applyImport(plan.skills, plan.docs, actor);
  const current = ctx.store.state().rules;
  const incoming = new Map(plan.rules.map((r) => [r.id, r]));
  const removed = current
    .filter((r) => r.id.startsWith(IMPORTED_RULE_PREFIX) && !incoming.has(r.id))
    .map((r) => r.id);
  const changed = plan.rules
    .filter((imported) => {
      const previous = current.find((r) => r.id === imported.id);
      return JSON.stringify(previous) !== JSON.stringify(importedRule(imported, previous));
    })
    .map((r) => r.id);
  if (changed.length + removed.length === 0) return { ...changes, rulesChanged: [] };
  await ctx.store.update((rules) => {
    const next = rules
      .filter((r) => !removed.includes(r.id))
      .map((r) => {
        const imported = incoming.get(r.id);
        return imported ? importedRule(imported, r) : r;
      });
    for (const imported of plan.rules)
      if (!next.some((r) => r.id === imported.id)) next.push(importedRule(imported, undefined));
    return next;
  });
  return { ...changes, rulesChanged: [...changed, ...removed] };
}
