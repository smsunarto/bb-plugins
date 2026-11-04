import { createHash } from "node:crypto";
import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { hostContract } from "../host-contract.ts";
import type { RuleStore } from "../server/lib/store.ts";
import { MAX_INSTRUCTIONS_LENGTH, type Rule } from "../shared/rules.ts";
import { textFilePattern } from "../shared/text-files.ts";
import { DOTFILES_AGENTS } from "./model.ts";
import type { Publisher } from "./publish.ts";
import { deliveredSkills } from "./shadow.ts";
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
import { treeSha } from "./tree.ts";
import {
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

/** The shadow check, with a failure reported instead of thrown. */
async function deliveredOrReport(bb: BbPluginApi, report: Report, allowShadow: boolean) {
  try {
    return await deliveredSkills(bb);
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
  options: { prune: boolean; keptRules: ReadonlySet<string> },
  report: Report,
) {
  const { prune, keptRules } = options;
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
      .rules.filter(
        (r) => r.id.startsWith(IMPORTED_RULE_PREFIX) && !rules.has(r.id) && !keptRules.has(r.id),
      )
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

/**
 * Entries the user edited or deleted in bb since they were imported. The
 * import skips them with a warning, so an edit made in bb is never lost.
 */
function keptInBb(ctx: CatalogContext, report: Report) {
  const authored = ctx.catalog.authoredNames();
  const deleted = ctx.catalog.deletedKeys();
  const authoredDocs = new Set(
    ctx.catalog
      .docs()
      .filter((d) => d.origin.kind === "authored")
      .map((d) => d.id),
  );
  return {
    skill(label: string, name: string): boolean {
      if (authored.has(name))
        report.warnings.push(`${label}: kept the version of ${name} edited in bb; skipped`);
      else if (deleted.skills.has(name))
        report.warnings.push(
          `${label}: ${name} was deleted in bb; restore it from Recently deleted to import it again`,
        );
      else return false;
      return true;
    },
    doc(id: string, origin: CatalogDoc["origin"]): boolean {
      const from = origin.kind === "imported" ? origin.from : id;
      if (authoredDocs.has(id))
        report.warnings.push(`${from}: kept the text edited in bb; skipped`);
      else if (deleted.docs.has(id))
        report.warnings.push(
          `${from}: deleted in bb; restore it from Recently deleted to import it again`,
        );
      else return false;
      return true;
    },
  };
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

  const delivered = await deliveredOrReport(ctx.bb, report, options.allowShadow);
  const catalogSkills = ctx.catalog.skills();
  const stored = new Set(catalogSkills.map((s) => s.name));
  const kept = keptInBb(ctx, report);
  const skills = entries
    .filter((e) => !kept.skill(e.label, e.name))
    .map((e): CatalogSkill => {
      const owner = delivered.owners.get(e.name);
      if (owner)
        (options.allowShadow ? report.warnings : report.errors).push(
          `${e.label}: would hide the ${e.name} skill from ${owner}; pass --rename ${e.label}=<new-name>`,
        );
      if (delivered.user.has(e.name) && !stored.has(e.name))
        report.warnings.push(
          `${e.label}: bb already has a user skill named ${e.name}; publishing will leave it alone`,
        );
      const files = catalogFiles(e, refs, report);
      return {
        name: e.name,
        description: publishedDescription(e, files, report),
        origin: { kind: "imported", from: e.dir },
        files,
        treeSha: treeSha(files),
      };
    });

  const instructions = await planInstructions(ctx, source, listing.instructions, refs, report);
  const docs = instructions.docs.filter((d) => !kept.doc(d.id, d.origin));
  const keptRules = editedRules(ctx, new Map(instructions.rules.map((r) => [r.id, r])));
  for (const id of keptRules)
    report.warnings.push(`rule ${id}: kept the rule edited in bb; skipped`);
  const rules = instructions.rules.filter((r) => !keptRules.has(r.id));
  for (const group of refs.groups)
    report.warnings.push(
      `${group} names a whole plugin; flat skill names have no equivalent, so rewrite that sentence`,
    );

  checkRemovals(
    ctx,
    { skills, docs, rules },
    catalogSkills,
    { prune: options.prune, keptRules },
    report,
  );

  const renamed = entries
    .filter((e) => e.name !== e.original)
    .map((e) => ({ from: e.label, to: e.name }));
  return { source, skills, docs, rules, renamed, ...report };
}

export type ImportResult = ImportChanges & { rulesChanged: string[] };

/**
 * The stored form of an imported rule; a user's name, enabled flag, and extra
 * scoping survive. A rule the user edited is skipped instead (see `editedRules`).
 */
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

/** A hash of what a user can edit in a rule. Turning it on or off is not an edit. */
function ruleFingerprint(rule: Rule): string {
  const { name, instructions, when } = rule;
  const fields = [name, instructions, when.hosts, when.providers, when.models, when.projects];
  return sha256(Buffer.from(JSON.stringify(fields), "utf8"));
}

/**
 * Imported rules changed in the Rules tab since the import that wrote them; an
 * import keeps them as they are. A rule already equal to what this import would
 * write is not an edit, which also covers an import that stopped before it
 * recorded its hashes.
 */
function editedRules(
  ctx: CatalogContext,
  incoming: ReadonlyMap<string, ImportedRule>,
): Set<string> {
  const recorded = ctx.catalog.importedRuleHashes();
  const edited = ctx.store.state().rules.filter((rule) => {
    const last = recorded.get(rule.id);
    if (last === undefined || last === ruleFingerprint(rule)) return false;
    const imported = incoming.get(rule.id);
    return !imported || ruleFingerprint(importedRule(imported, rule)) !== ruleFingerprint(rule);
  });
  return new Set(edited.map((rule) => rule.id));
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
  // Checked again here, so a rule edited after the plan still wins.
  const edited = editedRules(ctx, new Map(plan.rules.map((r) => [r.id, r])));
  const incoming = new Map(plan.rules.filter((r) => !edited.has(r.id)).map((r) => [r.id, r]));
  const removed = current
    .filter(
      (r) => r.id.startsWith(IMPORTED_RULE_PREFIX) && !incoming.has(r.id) && !edited.has(r.id),
    )
    .map((r) => r.id);
  const skipped = [...changes.skipped, ...[...edited].map((id) => `rule ${id}`)];
  const changed = [...incoming.values()]
    .filter((imported) => {
      const previous = current.find((r) => r.id === imported.id);
      return JSON.stringify(previous) !== JSON.stringify(importedRule(imported, previous));
    })
    .map((r) => r.id);
  if (changed.length + removed.length > 0) {
    await ctx.store.update((rules) => {
      const next = rules
        .filter((r) => !removed.includes(r.id))
        .map((r) => {
          const imported = incoming.get(r.id);
          return imported ? importedRule(imported, r) : r;
        });
      for (const imported of incoming.values())
        if (!next.some((r) => r.id === imported.id)) next.push(importedRule(imported, undefined));
      return next;
    });
  }
  // Recorded only after the rules are stored, and from what was stored.
  const recorded = ctx.catalog.importedRuleHashes();
  const hashes = new Map<string, string>();
  for (const rule of ctx.store.state().rules) {
    if (!rule.id.startsWith(IMPORTED_RULE_PREFIX)) continue;
    const last = recorded.get(rule.id);
    if (!edited.has(rule.id)) hashes.set(rule.id, ruleFingerprint(rule));
    else if (last !== undefined) hashes.set(rule.id, last);
  }
  ctx.catalog.setImportedRuleHashes(hashes);
  return { ...changes, skipped, rulesChanged: [...changed, ...removed] };
}
