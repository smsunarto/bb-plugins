// Create or refresh a PR walkthrough site from the reusable template.
//
// Run with Bun:  bun run <skill-directory>/scripts/scaffold-site.ts [options]

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const OBSOLETE_TEMPLATE_PATHS = [
  "design-qa.md",
  "src/components/ui/card.tsx",
  "src/components/walkthrough/diff-browser.tsx",
  "src/components/walkthrough/graph-canvas.tsx",
];

const IGNORE_PATTERNS = ["node_modules", ".next", "out", "*.tsbuildinfo"];

const USAGE = `usage: scaffold-site.ts [-h] [--content CONTENT] [--output OUTPUT] [--diff DIFF]
                        [--include-full-context]

Create or refresh a PR walkthrough site from the reusable template.
`;

function usageError(message: string): never {
  process.stderr.write(USAGE);
  process.stderr.write(`scaffold-site.ts: error: ${message}\n`);
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseCliArgs(
  argv: string[],
  optionNames: string[],
  flagNames: string[],
): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (equals < 0 && flagNames.includes(name)) {
      flags.add(name);
      index += 1;
      continue;
    }
    if (optionNames.includes(name)) {
      if (equals >= 0) {
        values.set(name, token.slice(equals + 1));
        index += 1;
        continue;
      }
      const value: string | undefined = argv[index + 1];
      if (value === undefined) usageError(`argument ${name}: expected one argument`);
      values.set(name, value);
      index += 2;
      continue;
    }
    usageError(`unrecognized arguments: ${token}`);
  }
  return { values, flags };
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve like Python's Path.resolve(): absolute, with symlinks followed. */
function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(resolveRealPath(parent), path.basename(absolute));
  }
}

function globMatch(pattern: string, name: string): boolean {
  const source = `^${pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")}$`;
  return new RegExp(source).test(name);
}

function isIgnored(name: string): boolean {
  return IGNORE_PATTERNS.some((pattern) => globMatch(pattern, name));
}

function copyFileWithMetadata(source: string, destination: string): void {
  fs.copyFileSync(source, destination);
  const stats = fs.statSync(source);
  fs.chmodSync(destination, stats.mode);
  fs.utimesSync(destination, stats.atime, stats.mtime);
}

/** Recursive copy that merges into an existing tree, like shutil.copytree. */
function copyTree(source: string, destination: string, filterNames: boolean): void {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (filterNames && isIgnored(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyTree(from, to, filterNames);
    else copyFileWithMetadata(from, to);
  }
  const stats = fs.statSync(source);
  fs.utimesSync(destination, stats.atime, stats.mtime);
}

function main(argv: string[]): number {
  const parsed = parseCliArgs(
    argv,
    ["--content", "--output", "--diff"],
    ["--include-full-context"],
  );
  const contentArg = parsed.values.get("--content");
  const outputArg = parsed.values.get("--output") ?? ".pr-walkthrough/site";
  const diffArg = parsed.values.get("--diff");
  const includeFullContext = parsed.flags.has("--include-full-context");

  const skillDir = path.dirname(path.dirname(resolveRealPath(fileURLToPath(import.meta.url))));
  const template = path.join(skillDir, "assets", "site-template");
  if (!isDirectory(template)) fail(`template not found: ${template}`);

  if (contentArg !== undefined && !isDirectory(contentArg)) {
    fail("--content must be a directory containing index.mdx");
  }
  if (contentArg !== undefined && !isFile(path.join(contentArg, "index.mdx"))) {
    fail("--content must contain index.mdx");
  }
  if (diffArg !== undefined && !isFile(diffArg)) fail(`--diff file not found: ${diffArg}`);

  const output = resolveRealPath(outputArg);
  fs.mkdirSync(output, { recursive: true });
  for (const relativePath of OBSOLETE_TEMPLATE_PATHS) {
    fs.rmSync(path.join(output, relativePath), { recursive: true, force: true });
  }
  copyTree(template, output, true);

  if (contentArg !== undefined) {
    const target = path.join(output, "src", "content", "walkthrough");
    fs.rmSync(target, { recursive: true, force: true });
    copyTree(contentArg, target, false);
  }

  const patchTarget = path.join(output, "src", "data", "walkthrough.patch");
  if (diffArg !== undefined) fs.copyFileSync(diffArg, patchTarget);
  else if (contentArg !== undefined) fs.writeFileSync(patchTarget, "", "utf8");

  const fullContextMarker = path.join(output, "src", "data", "full-context.enabled");
  if (includeFullContext) {
    fs.writeFileSync(fullContextMarker, "localhost-only\n", "utf8");
  } else {
    fs.rmSync(fullContextMarker, { force: true });
    fs.rmSync(path.join(output, ".next"), { recursive: true, force: true });
    fs.rmSync(path.join(output, "out"), { recursive: true, force: true });
  }

  const compile = spawnSync(process.execPath, ["run", "scripts/compile-walkthrough.ts"], {
    cwd: output,
    stdio: "inherit",
  });
  if (compile.status !== 0) fail("walkthrough MDX compilation failed");

  process.stdout.write(`${output}\n`);
  return 0;
}

process.exit(main(process.argv.slice(2)));
