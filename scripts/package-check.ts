/** Build and inspect every npm tarball without publishing it. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { publishableWorkspacePlugins, type PluginManifest } from "./plugin-package";
import { publishableWorkspacePackages, type PackageManifest } from "./workspace-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Licence expressions a published plugin may declare. A plugin that embeds
 * third-party code may add terms on top of MIT, but only ones listed here:
 * adding an expression has to be a deliberate edit, not a typo that ships.
 */
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  // agentation bundles the upstream `agentation` package into dist/app.js.
  "MIT AND PolyForm-Shield-1.0.0",
]);

/** Paths that must never reach any npm package, whatever the allowlist says. */
const PACKAGE_FORBIDDEN_PATH = /\.woff2$|(^|\/)\.env|node_modules|__pycache__/;

/** Plugin bundles are self-contained and must not ship their source maps. */
const PLUGIN_FORBIDDEN_PATH = /\.map$/;

/** A manifest path bb resolves against the installed package root. */
interface BbTarget {
  /** Manifest location, for the error message. */
  label: string;
  /** The value as written in the manifest. */
  entry: string;
  /** A directory whose contents ship, rather than a single file. */
  tree: boolean;
}

/** Manifest path → the path npm reports for it inside the tarball. The
    trailing "/*" a skills root may carry is stripped the way bb strips it. */
function tarballPath(entry: string): string {
  return entry
    .replace(/^\.\/+/, "")
    .replace(/\/\*$/, "")
    .replace(/\/+$/, "");
}

interface PackageTarget {
  label: string;
  entry: string;
}

/** Manifest paths Node or npm resolves after installing an ordinary package. */
function packageTargets(manifest: PackageManifest): PackageTarget[] {
  const targets: PackageTarget[] = [];
  const add = (label: string, entry: unknown): void => {
    if (typeof entry === "string" && entry.trim() !== "") targets.push({ label, entry });
  };

  if (typeof manifest.bin === "string") {
    add("bin", manifest.bin);
  } else if (typeof manifest.bin === "object" && manifest.bin !== null) {
    for (const [name, entry] of Object.entries(manifest.bin)) add(`bin.${name}`, entry);
  }

  const visitExport = (label: string, value: unknown): void => {
    if (typeof value === "string") {
      add(label, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visitExport(`${label}[${index}]`, entry));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [condition, entry] of Object.entries(value)) {
      visitExport(`${label}.${condition}`, entry);
    }
  };
  visitExport("exports", manifest.exports);
  return targets;
}

/**
 * The package-root-relative paths `bun pm pack --dry-run` reports.
 *
 * bun has no `--json` for pack, so this reads the human output: one
 * `packed <size> <path>` line per entry, then a `Total files: <n>` summary.
 * Parsing prose is only safe if it fails loudly — an empty list would make
 * every "must not ship" check below pass vacuously — so the parsed count is
 * cross-checked against bun's own total and any disagreement throws.
 */
export function packedPaths(output: string): string[] {
  const paths: string[] = [];
  let total: number | null = null;
  for (const line of output.split("\n")) {
    const packed = /^\s*packed\s+\S+\s+(.+?)\s*$/.exec(line);
    if (packed !== null) {
      const path = packed[1];
      if (path === undefined) throw new Error("a packed entry has no path");
      paths.push(path);
      continue;
    }
    const summary = /^\s*Total files:\s*(\d+)\s*$/.exec(line);
    if (summary !== null) total = Number(summary[1]);
  }
  if (total === null) {
    throw new Error(
      '`bun pm pack --dry-run` printed no "Total files:" line — its output format changed, so the tarball contents cannot be trusted',
    );
  }
  if (paths.length !== total) {
    throw new Error(
      `parsed ${paths.length} packed paths but \`bun pm pack\` reported ${total} — its output format changed`,
    );
  }
  return paths;
}

/** Everything bb opens by manifest path once the package is unpacked. */
export function bbTargets(manifest: PluginManifest): BbTarget[] {
  const bb = manifest.bb ?? {};
  const targets: BbTarget[] = [];
  const file = (label: string, entry: unknown): void => {
    if (typeof entry === "string" && entry.trim() !== "") {
      targets.push({ label, entry, tree: false });
    }
  };

  file("bb.server", bb.server);
  file("bb.app", bb.app);
  // branding.icon is either a host icon NAME or a plugin-relative path. bb
  // reads it out of the package only in the "./" form (isPluginOwnedIconPath).
  if (typeof bb.branding?.icon === "string" && bb.branding.icon.startsWith("./")) {
    file("bb.branding.icon", bb.branding.icon);
  }
  file("bb.branding.logo.light", bb.branding?.logo?.light);
  file("bb.branding.logo.dark", bb.branding?.logo?.dark);
  for (const theme of bb.themes ?? []) {
    file(`bb.themes["${theme?.id ?? "?"}"].css`, theme?.css);
  }
  // bb.skills and bb.commands name directories; bb strips a trailing "/*".
  for (const [label, value] of [
    ["bb.skills", bb.skills],
    ["bb.commands", bb.commands],
  ] as const) {
    const entries = typeof value === "string" ? [value] : (value ?? []);
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.trim() === "") continue;
      targets.push({ label, entry, tree: true });
    }
  }
  return targets;
}

/**
 * Every file the source entries reach through relative imports, and whether the
 * tarball carries it.
 *
 * `bb.server` is the FALLBACK entry: for a managed install bb loads
 * `dist/server.js` by convention and only reads `bb.server` when no bundle
 * ships or when `dist/server.meta.json` records a different SDK version than
 * the running one (plugin-runtime.ts `resolveServerEntry`). The SDK is pre-1.0,
 * so minor bumps are breaking and that path is live. A fallback that reaches an
 * unpacked file is a fallback that throws, and shipping the entry alone is not
 * enough — the whole import closure has to travel with it.
 *
 * TypeScript's NodeNext style writes `./foo.js` for `foo.ts`, so a specifier is
 * probed against the source extensions before the literal one.
 */
export function sourceClosureProblems(
  dir: string,
  manifest: PluginManifest,
  paths: readonly string[],
): string[] {
  const packed = new Set(paths);
  const entries = [manifest.bb?.server, manifest.bb?.app].filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );

  const candidates = (base: string): string[] => {
    const out = [base];
    if (base.endsWith(".js")) out.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
    if (base.endsWith(".jsx")) out.push(`${base.slice(0, -4)}.tsx`);
    return out;
  };
  const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".css", "/index.ts", "/index.tsx"];

  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = entries.map((entry) => tarballPath(entry));

  while (queue.length > 0) {
    const rel = queue.pop();
    if (rel === undefined) break;
    if (seen.has(rel)) continue;
    seen.add(rel);

    if (!packed.has(rel)) {
      problems.push(
        `"${rel}" is reachable from a bb.* source entry but the tarball does not carry it` +
          ` — bb falls back to source when the prebuilt bundle is missing or SDK-stale,` +
          ` and that fallback would throw. Add it to the "files" allowlist.`,
      );
      continue;
    }
    if (/\.(css|json)$/.test(rel)) continue;

    let source: string;
    try {
      source = readFileSync(join(dir, rel), "utf8");
    } catch {
      continue;
    }
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = match[1];
      if (spec === undefined) continue;
      let base: string;
      if (spec.startsWith(".")) base = join(dirname(rel), spec);
      else if (spec.startsWith("@/")) base = spec.slice(2);
      else continue; // a bare package, resolved from node_modules
      const resolved = candidates(base)
        .flatMap((candidate) => EXTENSIONS.map((extension) => candidate + extension))
        .find((candidate) => existsSync(join(dir, candidate)));
      if (resolved !== undefined && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return problems;
}

/**
 * The install-time protocol of a dependency spec, or null when the registry
 * serves it. npm resolves the others from the publisher's machine or from a
 * git host, so a tarball carrying one installs for nobody else.
 */
export function nonRegistryProtocol(spec: string): string | null {
  const trimmed = spec.trim();
  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed)?.[1]?.toLowerCase();
  // `npm:` is the registry alias form (`npm:other-pkg@^1`), which is fine.
  if (protocol !== undefined) return protocol === "npm" ? null : protocol;
  if (/^[.~/]/.test(trimmed)) return "path";
  // `owner/repo` and `owner/repo#ref` are the GitHub shorthand.
  if (/^[^@\s][^\s]*\/[^\s]+$/.test(trimmed)) return "github shorthand";
  return null;
}

/**
 * Every reason this package cannot be published as it stands. Returns them all
 * rather than the first, so one run shows the whole repair list.
 *
 * `paths` is the file list npm would pack, package-root-relative.
 */
export function pluginPackageProblems(
  manifest: PluginManifest,
  paths: readonly string[],
): string[] {
  const problems: string[] = [];
  const files = new Set(paths);
  const hasTree = (prefix: string): boolean =>
    paths.some((path) => path === prefix || path.startsWith(`${prefix}/`));

  // ---- The check that decides whether the tarball installs at all. --------
  for (const target of bbTargets(manifest)) {
    const wanted = tarballPath(target.entry);
    if (wanted === "" || wanted.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(wanted)) {
      problems.push(`${target.label} "${target.entry}" is not a path inside the package`);
      continue;
    }
    if (target.tree ? hasTree(wanted) : files.has(wanted)) continue;
    problems.push(
      `${target.label} points at "${target.entry}", which the tarball does not carry` +
        ` — bb stats that path at install time and refuses the plugin.` +
        ` Add "${wanted}${target.tree ? "/" : ""}" to the "files" allowlist.`,
    );
  }
  // bb reads these two at fixed paths, whatever bb.server and bb.app say:
  // dist/app.js + dist/app.meta.json gate an npm install outright
  // (managed-plugin-artifacts.ts), and the runtime reads dist/server.meta.json.
  const fixed = ["dist/server.meta.json"];
  if (manifest.bb?.app) fixed.push("dist/app.js", "dist/app.meta.json");
  for (const path of fixed) {
    if (!files.has(path)) {
      problems.push(`the tarball has no ${path}, which bb requires of an npm plugin`);
    }
  }

  const forbidden = paths.filter((path) => PLUGIN_FORBIDDEN_PATH.test(path));
  if (forbidden.length > 0) problems.push(`tarball carries ${forbidden.join(", ")}`);

  return [...problems, ...packageProblems(manifest, paths)];
}

/** Every reason an ordinary npm package cannot be published as it stands. */
export function packageProblems(manifest: PackageManifest, paths: readonly string[]): string[] {
  const problems: string[] = [];
  const files = new Set(paths);

  for (const target of packageTargets(manifest)) {
    const wanted = tarballPath(target.entry);
    if (wanted === "" || wanted.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(wanted)) {
      problems.push(`${target.label} "${target.entry}" is not a path inside the package`);
      continue;
    }
    if (!files.has(wanted)) {
      problems.push(
        `${target.label} points at "${target.entry}", which the tarball does not carry`,
      );
    }
  }

  // ---- Distribution hygiene. ---------------------------------------------
  const forbidden = paths.filter((path) => PACKAGE_FORBIDDEN_PATH.test(path));
  if (forbidden.length > 0) problems.push(`tarball carries ${forbidden.join(", ")}`);
  if (!files.has("LICENSE")) problems.push("tarball has no LICENSE");

  // ---- Manifest policy. ---------------------------------------------------
  if (!ALLOWED_LICENSES.has(manifest.license ?? "")) {
    problems.push(
      `licence ${JSON.stringify(manifest.license)} is not one of ` +
        `${[...ALLOWED_LICENSES].map((value) => JSON.stringify(value)).join(", ")}` +
        ` — add it to ALLOWED_LICENSES in scripts/package-check.ts if it is intended`,
    );
  }
  // A compound expression is there because the package bundles code under the
  // extra terms. Those terms have to travel with it, not stay in the repo.
  const license = manifest.license ?? "";
  if (ALLOWED_LICENSES.has(license) && license !== "MIT" && !files.has("THIRD_PARTY_NOTICES.md")) {
    problems.push(
      `licence "${license}" adds terms beyond MIT, but the tarball carries no THIRD_PARTY_NOTICES.md stating them`,
    );
  }
  if (!Array.isArray(manifest.files)) problems.push("manifest has no files allowlist");
  if (manifest.private === true) {
    problems.push('manifest is `"private": true` — npm refuses to publish it');
  }
  for (const field of ["description", "repository", "author"] as const) {
    const value = manifest[field];
    if (
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim() === "")
    ) {
      problems.push(`manifest has no ${field}, which every published package needs`);
    }
  }
  // A scoped name defaults to a restricted (paid) publish. The CLI passes
  // --access public too; the manifest states the intent for anyone who runs
  // `npm publish` by hand.
  if (manifest.publishConfig?.access !== "public") {
    problems.push(
      'manifest has no `publishConfig.access: "public"` — a scoped package defaults to a restricted publish',
    );
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const protocol = nonRegistryProtocol(spec);
      if (protocol !== null) {
        problems.push(
          `${field}.${name} is "${spec}" (${protocol}), which the registry cannot serve to an installer`,
        );
      }
    }
  }

  return problems;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8" }).trim();
}
function main(): void {
  const fail = (message: string): never => {
    console.error(`\n✗ ${message}`);
    process.exit(1);
  };

  const packages = publishableWorkspacePackages(ROOT);
  const plugins = publishableWorkspacePlugins(ROOT);
  console.log(`checking ${packages.length} framework package and ${plugins.length} plugins\n`);

  run("bun", ["run", "build:framework"], ROOT);
  run(
    "bun",
    ["run", ...plugins.flatMap((plugin) => ["--filter", plugin.name]), "--parallel", "build"],
    ROOT,
  );

  for (const candidate of packages) {
    const paths = packedPaths(run("bun", ["pm", "pack", "--dry-run"], candidate.dir));
    const problems = packageProblems(candidate.manifest, paths);
    if (problems.length > 0) {
      fail(
        `${candidate.directory} cannot be published:\n${problems.map((problem) => `    - ${problem}`).join("\n")}`,
      );
    }
    console.log(`  ${candidate.name} ready (${paths.length} files)`);
  }

  for (const plugin of plugins) {
    const { directory: id, dir, manifest } = plugin;
    const version =
      typeof manifest.version === "string" && manifest.version.trim() !== ""
        ? manifest.version
        : fail(`${id}: package.json has no version`);
    if (!existsSync(join(dir, "LICENSE"))) fail(`${id}: no LICENSE in the package`);

    for (const artifact of ["server", ...(manifest.bb?.app ? ["app"] : [])]) {
      const metaPath = join(dir, "dist", `${artifact}.meta.json`);
      if (!existsSync(metaPath)) fail(`${id}: missing dist/${artifact}.meta.json — build first`);
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      if (meta.pluginVersion !== version) {
        fail(
          `${id}: dist/${artifact}.meta.json stamps ${meta.pluginVersion}, manifest says ${version}`,
        );
      }
    }

    // `bun pm pack --dry-run` reports exactly the entries a real pack writes,
    // so this is the tarball's contents without producing one.
    const paths = packedPaths(run("bun", ["pm", "pack", "--dry-run"], dir));

    const problems = [
      ...pluginPackageProblems(manifest, paths),
      ...sourceClosureProblems(dir, manifest, paths),
    ];
    if (problems.length > 0) {
      fail(
        `${id} cannot be published:\n${problems.map((problem) => `    - ${problem}`).join("\n")}`,
      );
    }
    console.log(`  ${plugin.name}@${version} ready (${paths.length} files)`);
  }

  console.log("\nall npm packages are ready");
}

if (import.meta.main) main();
