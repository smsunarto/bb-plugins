/** Track plugin code that compensates for a bb defect, so a bb upgrade can retire it.
 *
 * Each workaround in workarounds.json owns whole files and blocks fenced by
 * `workaround:<id> begin` / `workaround:<id> end` comment lines. A manual entry
 * only tags its code with a `workaround:<id>` comment, because removing it
 * means rewriting callers.
 *
 *   bun scripts/workarounds.ts check [--bb <bb-app dir>] [--json]
 *   bun scripts/workarounds.ts remove <id> [--no-verify]
 *
 * `check` reads the installed bb (the `bb-app` package; found from $BB_CLI or
 * `bb` on PATH) and probes each entry. A probe reports `fixed` only on a
 * positive sign of the fix. A bug signature that has gone missing is `unknown`,
 * never `fixed`, because minified bundles change with every build. `remove`
 * deletes the entry's files, fenced blocks, and registry entry, then runs its
 * `afterRemoval` commands.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface Workaround {
  id: string;
  defect: string;
  verifiedOn: string;
  /** The bb issue or pull request that fixes the defect. */
  upstream?: string;
  files?: string[];
  manual?: string;
  probe: { needed: string | null; fixed: string | null };
  afterRemoval: string[];
  verify: string;
}
export type Status = "fixed" | "needed" | "unknown";

const root = resolve(import.meta.dir, "..");
const registryPath = join(root, "workarounds.json");
const MARKER = /workaround:([\w./-]+)(?:\s+(begin|end))?/;

export function readRegistry(path = registryPath): { workarounds: Workaround[] } {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Every `workaround:<id>` comment in tracked files: fenced blocks and bare tags. */
export function scanMarkers(files: readonly string[], read: (file: string) => string) {
  const markers: Array<{ file: string; line: number; id: string; kind: "begin" | "end" | "tag" }> =
    [];
  for (const file of files) {
    if (file === "workarounds.json" || file.startsWith("scripts/workarounds.")) continue;
    const text = read(file);
    if (!text.includes("workaround:")) continue;
    text.split("\n").forEach((source, index) => {
      const match = MARKER.exec(source);
      if (match)
        markers.push({ file, line: index + 1, id: match[1]!, kind: match[2] ?? "tag" } as never);
    });
  }
  return markers;
}

/** Drop each `begin`..`end` block for `id`, fences included, and the blank line a removal leaves doubled. */
export function stripBlocks(text: string, id: string): string {
  const out: string[] = [];
  let depth = 0;
  let removed = false;
  for (const line of text.split("\n")) {
    const match = MARKER.exec(line);
    const fence = match?.[1] === id ? match[2] : undefined;
    if (fence === "begin" || fence === "end") {
      depth += fence === "begin" ? 1 : -1;
      if (depth < 0) break;
      removed = true;
      continue;
    }
    if (depth > 0) continue;
    if (removed && line.trim() === "" && out.at(-1)?.trim() === "") {
      removed = false;
      continue;
    }
    removed = false;
    out.push(line);
  }
  if (depth !== 0) throw new Error(`Unbalanced workaround:${id} fences`);
  return out.join("\n");
}

/** The installed bb-app package directory. */
export function findBb(explicit?: string): string {
  if (explicit) return resolve(explicit);
  const cli =
    process.env.BB_CLI ?? execFileSync("sh", ["-c", "command -v bb"], { encoding: "utf8" }).trim();
  // <bb-app>/host-daemon/dist/bb
  return resolve(dirname(realpathSync(cli)), "../..");
}

function assetText(bbApp: string): string {
  const assets = join(bbApp, "app/dist/assets");
  if (!existsSync(assets)) throw new Error(`No bb web assets at ${assets}; pass --bb <bb-app dir>`);
  return readdirSync(assets)
    .filter((name) => name.endsWith(".js") || name.endsWith(".css"))
    .map((name) => readFileSync(join(assets, name), "utf8"))
    .join("\n");
}

export function probe(entry: Workaround, assets: string): Status {
  if (entry.probe.fixed && new RegExp(entry.probe.fixed).test(assets)) return "fixed";
  if (entry.probe.needed && new RegExp(entry.probe.needed).test(assets)) return "needed";
  return "unknown";
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => file && existsSync(join(root, file)) && lstatSync(join(root, file)).isFile());
}

function check(args: string[]) {
  const bbIndex = args.indexOf("--bb");
  const bbApp = findBb(bbIndex >= 0 ? args[bbIndex + 1] : undefined);
  const version = JSON.parse(readFileSync(join(bbApp, "package.json"), "utf8")).version as string;
  const assets = assetText(bbApp);
  const results = readRegistry().workarounds.map((entry) => ({
    id: entry.id,
    status: probe(entry, assets),
    upgraded: entry.verifiedOn !== version,
    verifiedOn: entry.verifiedOn,
    verify: entry.verify,
  }));
  if (args.includes("--json")) {
    console.log(JSON.stringify({ bb: version, results }, null, 2));
    return;
  }
  console.log(`bb ${version} (${bbApp})`);
  for (const result of results) {
    const note = result.upgraded ? ` — last verified on ${result.verifiedOn}` : "";
    console.log(`${result.status.padEnd(7)} ${result.id}${note}`);
    if (result.status !== "needed") console.log(`        verify: ${result.verify}`);
  }
}

function remove(args: string[]) {
  const id = args[0];
  if (!id) throw new Error("usage: bun scripts/workarounds.ts remove <id>");
  const registry = readRegistry();
  const entry = registry.workarounds.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`No workaround ${id} in workarounds.json`);
  if (entry.manual) throw new Error(`${id} needs manual removal: ${entry.manual}`);
  // Plan every edit before touching a file, so a failure leaves the tree as it was.
  const fenced = new Set(
    scanMarkers(trackedFiles(), (file) => readFileSync(join(root, file), "utf8"))
      .filter((marker) => marker.id === id)
      .map((marker) => marker.file),
  );
  const owned = new Set(entry.files ?? []);
  const edits = [...fenced]
    .filter((file) => !owned.has(file))
    .map((file) => ({ file, text: stripBlocks(readFileSync(join(root, file), "utf8"), id) }));
  for (const file of owned) rmSync(join(root, file), { force: true });
  for (const { file, text } of edits) writeFileSync(join(root, file), text);
  if (edits.length > 0)
    execFileSync("bunx", ["oxfmt", ...edits.map(({ file }) => file)], {
      cwd: root,
      stdio: "ignore",
    });
  registry.workarounds = registry.workarounds.filter((candidate) => candidate.id !== id);
  writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`Removed ${id}: ${[...owned, ...edits.map(({ file }) => file)].join(", ")}`);
  if (args.includes("--no-verify")) return;
  for (const command of entry.afterRemoval) {
    console.log(`$ ${command}`);
    execFileSync("sh", ["-c", command], { cwd: root, stdio: "inherit" });
  }
  console.log(`Now verify by hand: ${entry.verify}`);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") check(args);
  else if (command === "remove") remove(args);
  else {
    console.error(
      "usage: bun scripts/workarounds.ts check [--bb <dir>] [--json] | remove <id> [--no-verify]",
    );
    process.exit(2);
  }
}
