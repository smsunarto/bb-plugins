/** Hold every plugin to one set of edges, colors, and shared primitives.
 *
 * Existing drift is frozen in style-baseline.json and may only shrink. A new
 * plugin starts with no entries, so it must follow the contract from its first
 * commit. Run `bun scripts/style-contract.ts --update` after fixing drift.
 *
 * packages/ui/registry holds the canonical copy of each shadcn kit file that
 * plugins vendor under components/ui (Tailwind scans only the plugin's own
 * tree, so these cannot be imported from the package). A plugin copy must
 * match it byte for byte; `--sync <plugin>` copies it in.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

export interface Rule {
  id: string;
  /** Matches one occurrence on a comment-stripped line. */
  pattern: RegExp;
  extensions: readonly string[];
  fix: string;
}
export interface Violation {
  file: string;
  rule: string;
  source: string;
  line: number;
}

export const rules: readonly Rule[] = [
  {
    id: "edge-opacity",
    pattern: /\b(?:border|ring|divide|outline)-border\/\d+/g,
    extensions: [".tsx", ".ts"],
    fix: "Use border-border, or the edge classes from @bb-plugins/ui/surface; do not pick a per-plugin edge opacity.",
  },
  {
    id: "ring-edge",
    pattern: /(?<![\w:/-])ring-border(?![\w/-])/g,
    extensions: [".tsx", ".ts"],
    fix: "Draw an edge with a border or the shared edge classes, not a border-colored ring; rings mark focus and selection.",
  },
  {
    id: "arbitrary-edge",
    pattern: /\b(?:rounded(?:-[trbl]{1,2})?|shadow|border(?:-[trblxy])?|ring)-\[[^\]]+\]/g,
    extensions: [".tsx", ".ts"],
    fix: "Use the theme's radius, shadow, and border utilities, or a shared surface class.",
  },
  {
    id: "hairline-literal",
    pattern: /\b0?\.5px\b/g,
    extensions: [".tsx", ".ts", ".css"],
    fix: "Use the hairline classes from @bb-plugins/ui/surface instead of writing a 0.5px edge.",
  },
  {
    id: "raw-color",
    pattern:
      /(?<![\w&$/-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?|oklch|oklab|color-mix)\(/g,
    extensions: [".tsx", ".css"],
    fix: "Use a theme color variable. Add a missing color to plugins/monokai first (CLAUDE.md, Dev Preferences).",
  },
  {
    id: "universal-bucket",
    pattern: /(?<![\w-])(?:space-[xy]-|divide-[xy](?![\w-]))/g,
    extensions: [".tsx", ".ts"],
    fix: "Use flex flex-col gap-* or row borders; space-* and divide-* match every element (CLAUDE.md, Performance).",
  },
];

/** File-level rule: a shared primitive must be a re-export, not a local copy. */
export const LOCAL_PRIMITIVE = "local-primitive";
const localPrimitiveFix =
  "Re-export the component from @bb-plugins/ui instead of keeping a local copy.";

/** The palette owner and the shared package define what this contract enforces. */
const exemptPrefixes = ["plugins/monokai/", "packages/ui/src/"];
const exemptSegments = ["/dist/", "/node_modules/", "/test/", "/tests/", "/__tests__/"];

export function scanned(file: string): boolean {
  if (!file.startsWith("plugins/") && !file.startsWith("packages/")) return false;
  if (exemptPrefixes.some((prefix) => file.startsWith(prefix))) return false;
  if (exemptSegments.some((segment) => file.includes(segment))) return false;
  if (/\.(?:test|spec|stories|d)\.tsx?$/.test(file)) return false;
  return /\.(?:tsx|ts|css)$/.test(file);
}

/** Blank comments but keep line numbers, so findings point at real lines. */
export function stripComments(source: string, file: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  let out = source.replace(/\/\*[\s\S]*?\*\//g, blank);
  if (!file.endsWith(".css"))
    out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
  return out;
}

export function scanFile(file: string, source: string): Violation[] {
  const found: Violation[] = [];
  const ext = file.slice(file.lastIndexOf("."));
  const original = source.split("\n");
  const lines = stripComments(source, file).split("\n");
  for (const rule of rules) {
    if (!rule.extensions.includes(ext)) continue;
    lines.forEach((text, index) => {
      for (const _ of text.matchAll(rule.pattern))
        found.push({ file, rule: rule.id, line: index + 1, source: original[index]!.trim() });
    });
  }
  return found;
}

/** Component names @bb-plugins/ui exports, read from its package exports. */
export function sharedPrimitives(root = "."): Set<string> {
  const pkg = JSON.parse(readFileSync(`${root}/packages/ui/package.json`, "utf8"));
  return new Set(
    Object.keys(pkg.exports as Record<string, string>)
      .map((key) => key.replace(/^\.\//, ""))
      .filter((name) => name !== "utils"),
  );
}

export function isReExport(source: string): boolean {
  const rest = stripComments(source, "x.tsx").replace(
    /export\s+(?:type\s+)?(?:\{[^}]*\}|\*)\s*from\s*["']@bb-plugins\/ui\/[\w-]+["'];?/g,
    "",
  );
  return rest.trim() === "" && rest !== stripComments(source, "x.tsx");
}

export function scanPrimitive(file: string, source: string, shared: Set<string>): Violation[] {
  if (basename(dirname(file)) !== "ui" || basename(dirname(dirname(file))) !== "components")
    return [];
  const name = basename(file).replace(/\.tsx?$/, "");
  if (!shared.has(name) || isReExport(source)) return [];
  return [{ file, rule: LOCAL_PRIMITIVE, line: 1, source: name }];
}

/** File-level rule: a plugin's copy of a registry kit file matches the canonical copy. */
export const REGISTRY_DRIFT = "registry-drift";
const registryDriftFix =
  "Edit packages/ui/registry instead, then copy it into each plugin with bun scripts/style-contract.ts --sync <plugin>.";
export const registryRoot = "packages/ui/registry";

/** The kit path of a plugin's components/ui file, such as hooks/use-media-query.ts. */
export function kitPath(file: string): string | undefined {
  if (!file.startsWith("plugins/")) return undefined;
  return /\/components\/ui\/(.+)$/.exec(file)?.[1];
}

export function scanRegistry(file: string, source: string, root = "."): Violation[] {
  const rel = kitPath(file);
  if (!rel) return [];
  let canonical: string;
  try {
    canonical = readFileSync(`${root}/${registryRoot}/${rel}`, "utf8");
  } catch {
    return [];
  }
  return canonical === source ? [] : [{ file, rule: REGISTRY_DRIFT, line: 1, source: rel }];
}

export function scanRepository(root = "."): Violation[] {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(scanned);
  const shared = sharedPrimitives(root);
  const found: Violation[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(`${root}/${file}`, "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    found.push(
      ...scanFile(file, source),
      ...scanPrimitive(file, source, shared),
      ...scanRegistry(file, source, root),
    );
  }
  return found;
}

export type Entry = Omit<Violation, "line">;
export const key = (entry: Entry) => JSON.stringify([entry.file, entry.rule, entry.source]);

/** Violations beyond the baseline's count for the same file, rule, and line text. */
export function unrecorded<T extends Entry>(actual: readonly T[], baseline: readonly Entry[]): T[] {
  const remaining = new Map<string, number>();
  for (const entry of baseline) remaining.set(key(entry), (remaining.get(key(entry)) ?? 0) + 1);
  return actual.filter((violation) => {
    const count = remaining.get(key(violation)) ?? 0;
    if (count === 0) return true;
    remaining.set(key(violation), count - 1);
    return false;
  });
}

export function fixFor(rule: string): string {
  if (rule === LOCAL_PRIMITIVE) return localPrimitiveFix;
  if (rule === REGISTRY_DRIFT) return registryDriftFix;
  return rules.find((candidate) => candidate.id === rule)?.fix ?? "";
}

export const baselinePath = new URL("./style-baseline.json", import.meta.url);
export const readBaseline = (): Entry[] => JSON.parse(readFileSync(baselinePath, "utf8"));

function toBaseline(found: readonly Violation[]): Entry[] {
  return found
    .map(({ file, rule, source }) => ({ file, rule, source }))
    .sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Overwrite a plugin's existing kit files with the canonical copies. */
export function syncPlugin(plugin: string, root = "."): string[] {
  const written: string[] = [];
  const files = execFileSync("git", ["ls-files", `plugins/${plugin}`], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
  for (const file of files) {
    const rel = kitPath(file);
    if (!rel) continue;
    let canonical: string;
    try {
      canonical = readFileSync(`${root}/${registryRoot}/${rel}`, "utf8");
    } catch {
      continue;
    }
    if (readFileSync(`${root}/${file}`, "utf8") === canonical) continue;
    writeFileSync(`${root}/${file}`, canonical);
    written.push(file);
  }
  return written;
}

if (import.meta.main) {
  const syncIndex = process.argv.indexOf("--sync");
  if (syncIndex !== -1) {
    const plugin = process.argv[syncIndex + 1];
    if (!plugin) throw new Error("Expected --sync <plugin>");
    for (const file of syncPlugin(plugin)) console.log(`synced ${file}`);
    process.exit(0);
  }
  const found = scanRepository();
  if (process.argv.includes("--update")) {
    writeFileSync(baselinePath, JSON.stringify(toBaseline(found), null, 2) + "\n");
    console.log(`Recorded ${found.length} existing style-contract entries.`);
  } else {
    const added = unrecorded(found, readBaseline());
    const resolved = unrecorded(readBaseline(), found).length;
    for (const v of added)
      console.log(`${v.file}:${v.line}: ${v.rule}: ${fixFor(v.rule)}\n  ${v.source}`);
    const counts = new Map<string, number>();
    for (const v of found) {
      const plugin = v.file.split("/").slice(0, 2).join("/");
      counts.set(plugin, (counts.get(plugin) ?? 0) + 1);
    }
    if (process.argv.includes("--summary"))
      for (const [plugin, count] of [...counts].sort((a, b) => b[1] - a[1]))
        console.log(`${String(count).padStart(5)} ${plugin}`);
    console.log(`${found.length - added.length} known; ${added.length} new; ${resolved} resolved.`);
    if (resolved)
      console.log("Prune resolved entries with bun scripts/style-contract.ts --update.");
    process.exit(added.length ? 1 : 0);
  }
}
