/** Build the @bb-plugins shadcn registry that plugins install kit files from.
 *
 * Source: packages/ui/registry/registry.json, whose file paths are relative to
 * that directory. Output: packages/ui/r/<item>.json plus registry.json, the
 * built form the shadcn CLI fetches through the `@bb-plugins` entry in each
 * plugin's components.json. The output is committed because plugins read it
 * from GitHub; `--check` fails when it is stale, so edit the source and rerun
 * `bun scripts/shadcn-registry.ts`.
 *
 * Items carry no `target`, so the CLI places each file under the plugin's own
 * `ui`, `lib`, or `hooks` alias. Built paths start with
 * `registry/components/ui/`, `registry/lib/`, or `registry/hooks/`, which the
 * CLI strips; a `registry:ui` file keeps the rest of its path, so the
 * use-media-query family lands in components/ui/hooks beside its importers,
 * while a `registry:hook` file lands in the plugin's own hooks folder.
 *
 * Kit files are also vendored byte for byte (scripts/style-contract.ts,
 * registry-drift), so the built content is the source file unchanged.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const sourceDir = "packages/ui/registry";
export const outputDir = "packages/ui/r";
const itemSchema = "https://ui.shadcn.com/schema/registry-item.json";
/** This registry's namespace. A bare dependency means the official shadcn item,
 * and bb's `@bb/` items set a fixed `target` that writes outside a nested
 * plugin layout, so every dependency must be an item of this registry. */
const self = "@bb-plugins/";

export interface RegistryFile {
  path: string;
  type: string;
  /** Rejected by problems(): a fixed target ignores the plugin's aliases. */
  target?: string;
}
export interface RegistryItem {
  name: string;
  type: string;
  registryDependencies?: string[];
  files?: RegistryFile[];
  [field: string]: unknown;
}
export interface Registry {
  name: string;
  homepage: string;
  items: RegistryItem[];
  [field: string]: unknown;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** The path the CLI maps onto the plugin's alias: stubs/ is a source-only folder. */
export function builtPath(file: RegistryFile): string {
  if (file.type === "registry:lib") return `registry/lib/${basename(file.path)}`;
  if (file.type === "registry:hook") return `registry/hooks/${basename(file.path)}`;
  return `registry/components/ui/${file.path.replace(/^stubs\//, "")}`;
}

function fileProblem(file: RegistryFile, root: string): string | undefined {
  const source = join(root, sourceDir, file.path);
  if (!existsSync(source)) return "does not exist";
  // The CLI drops a file's leading comment on install, so the vendored copy
  // would no longer match its canonical source.
  if (/^\s*(?:\/\/|\/\*)/.test(readFileSync(source, "utf8")))
    return "starts with a comment, which shadcn add strips";
  if (!["registry:ui", "registry:lib", "registry:hook"].includes(file.type))
    return "must be registry:ui, registry:lib, or registry:hook";
  if (file.target !== undefined) return "must not set a target; the plugin's aliases place it";
  return undefined;
}

function dependencyProblem(dependency: string, names: Set<string>): string | undefined {
  if (!dependency.startsWith(self)) return `is not a ${self} item; name it in docs`;
  if (!names.has(dependency.slice(self.length))) return "is not an item in this registry";
  return undefined;
}

/** Problems that would make an item fail to install. */
export function problems(registry: Registry, root = "."): string[] {
  const found: string[] = [];
  const names = new Set<string>();
  for (const item of registry.items) {
    if (names.has(item.name)) found.push(`${item.name}: duplicate item name`);
    names.add(item.name);
  }
  for (const item of registry.items) {
    for (const file of item.files ?? []) {
      const problem = fileProblem(file, root);
      if (problem) found.push(`${item.name}: ${file.path} ${problem}`);
    }
    for (const dependency of item.registryDependencies ?? []) {
      const problem = dependencyProblem(dependency, names);
      if (problem) found.push(`${item.name}: ${dependency} ${problem}`);
    }
  }
  return found;
}

/** The built files, keyed by their path under outputDir. */
export function build(root = "."): Map<string, string> {
  const registry: Registry = JSON.parse(
    readFileSync(join(root, sourceDir, "registry.json"), "utf8"),
  );
  const errors = problems(registry, root);
  if (errors.length) throw new Error(errors.join("\n"));
  const out = new Map<string, string>();
  const { $schema: _schema, items, ...meta } = registry;
  out.set(
    "registry.json",
    json({
      $schema: "https://ui.shadcn.com/schema/registry.json",
      ...meta,
      items: items.map(({ files, ...item }) => ({
        ...item,
        files: files?.map((file) => ({ path: builtPath(file), type: file.type })),
      })),
    }),
  );
  for (const { files, ...item } of items)
    out.set(
      `${item.name}.json`,
      json({
        $schema: itemSchema,
        ...item,
        files: files?.map((file) => ({
          path: builtPath(file),
          content: readFileSync(join(root, sourceDir, file.path), "utf8"),
          type: file.type,
        })),
      }),
    );
  return out;
}

/** Built files that are missing, changed, or no longer produced. */
export function stale(root = "."): string[] {
  const built = build(root);
  const dir = join(root, outputDir);
  const existing = existsSync(dir) ? readdirSync(dir) : [];
  const changed = [...built].filter(
    ([name, content]) =>
      !existsSync(join(dir, name)) || readFileSync(join(dir, name), "utf8") !== content,
  );
  return [
    ...changed.map(([name]) => name),
    ...existing.filter((name) => name.endsWith(".json") && !built.has(name)),
  ];
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const names = stale();
    for (const name of names) console.log(`stale: ${outputDir}/${name}`);
    if (names.length) console.log("Rebuild with bun scripts/shadcn-registry.ts.");
    process.exit(names.length ? 1 : 0);
  }
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const built = build();
  for (const [name, content] of built) writeFileSync(join(outputDir, name), content);
  console.log(`Built ${built.size - 1} items into ${outputDir}.`);
}
