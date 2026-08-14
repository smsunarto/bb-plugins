/**
 * Publish the supportable plugins to npm.
 *
 * npm is the only bb install channel that does not fetch a whole repository:
 * `bb plugin install npm:<name>` pulls one tarball. `git:<url>@<ref>` runs a
 * full `git clone` and reads the manifest at the repository ROOT
 * (managed-plugin-artifacts.ts: `git clone --quiet`, then `stagedRoot =
 * stagingDir`), and its parsed source carries only a url and a ref — there is
 * no subdirectory field. So a monorepo plugin cannot be installed over git: at
 * bb 0.37, and npm is the channel.
 *
 * That makes the tarball the product, and everything bb reads at install time
 * has to be INSIDE it. bb never builds an npm plugin: it stats the manifest's
 * `bb.*` paths against the unpacked package and refuses what is missing, so a
 * `files` allowlist that omits one of them ships a package that installs
 * nowhere. The gate below packs each plugin and looks for those paths in the
 * result — a check that costs one `npm pack --dry-run` and is the difference
 * between a release and eight dead tarballs.
 *
 *   bun scripts/publish.ts --dry-run     # pack and check, publish nothing
 *   bun scripts/publish.ts               # the real thing
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  workspacePlugins,
  unscopedPackageName,
  type PluginManifest,
  type WorkspacePlugin,
} from "./plugin-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Not published:
 * - dotfiles: personal tooling written against one repository layout, and its
 *   README says so. Publishing it would invite installs it cannot serve.
 * - pr-walkthrough: not ready for a public release.
 * Both also carry `"private": true`, which npm itself refuses to publish; this
 * set keeps them out of the gate rather than letting them fail it.
 */
export const EXCLUDED = new Set(["dotfiles", "pr-walkthrough"]);

/**
 * The workspace packages that may be published and receive GitHub Releases.
 *
 * Keep the explicit release policy and npm's `private` safety switch in step.
 * A mismatch is an error instead of silently publishing or silently omitting a
 * package from one half of the release process.
 */
export function publishableWorkspacePlugins(root: string): WorkspacePlugin[] {
  const plugins = workspacePlugins(root);
  for (const plugin of plugins) {
    const excluded = EXCLUDED.has(plugin.directory);
    const privatePackage = plugin.manifest.private === true;
    if (excluded !== privatePackage) {
      throw new Error(
        `${plugin.directory}: EXCLUDED and package.json private must agree`,
      );
    }
  }
  return plugins.filter((plugin) => !EXCLUDED.has(plugin.directory));
}

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

/**
 * The unscoped twin of a scoped package name, or null when there is none.
 *
 * Both names derive the SAME bb plugin id — `@smsunarto/bb-plugin-notify` and
 * `bb-plugin-notify` both give `notify`, because derivePluginId() drops the
 * scope before it strips the prefix. So the mirror is not a second plugin: it
 * is the same tarball under a second registry name, published so that the
 * short name cannot be taken by anyone else.
 *
 * It ships the real package rather than an empty placeholder on purpose. npm's
 * Open-Source Terms forbid publishing content that exists only to reserve a
 * name, and reclaim it without notice; a functional package is not squatting.
 *
 * The two names are alternatives, never companions — a user who installed both
 * would give bb two plugins claiming one id.
 */
export function mirrorPackageName(name: string): string | null {
  const unscoped = unscopedPackageName(name);
  return unscoped === name ? null : unscoped;
}

/** Paths that must never reach a tarball, whatever the allowlist says. */
const FORBIDDEN_PATH =
  /\.woff2$|\.map$|(^|\/)\.env|node_modules|__pycache__/;

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
      paths.push(packed[1]);
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
    const rel = queue.pop() as string;
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
export function publishProblems(
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

  // ---- Distribution hygiene. ---------------------------------------------
  const forbidden = paths.filter((path) => FORBIDDEN_PATH.test(path));
  if (forbidden.length > 0) problems.push(`tarball carries ${forbidden.join(", ")}`);
  if (!files.has("LICENSE")) problems.push("tarball has no LICENSE");

  // ---- Manifest policy. ---------------------------------------------------
  if (!ALLOWED_LICENSES.has(manifest.license ?? "")) {
    problems.push(
      `licence ${JSON.stringify(manifest.license)} is not one of ` +
        `${[...ALLOWED_LICENSES].map((value) => JSON.stringify(value)).join(", ")}` +
        ` — add it to ALLOWED_LICENSES in scripts/publish.ts if it is intended`,
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
    problems.push(
      'manifest is `"private": true` — npm refuses to publish it. Drop the flag, or add the plugin to EXCLUDED in scripts/publish.ts',
    );
  }
  for (const field of ["description", "repository", "author"] as const) {
    const value = manifest[field];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
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
  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
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

/**
 * Like run(), but the child keeps this terminal.
 *
 * `npm publish` can need the user: a web auth handshake, or a 2FA one-time
 * password. Those prompts go to stdout, so capturing it the way run() does
 * leaves npm waiting on a keypress for a prompt nobody was shown — the publish
 * looks hung when it is only asking a question.
 */
function runInteractive(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

/** Like run(), but a non-zero exit is an answer rather than a failure, and the
    command's own stderr stays off the console. Used for registry probes, where
    "not published yet" arrives as a 404. */
function probe(command: string, args: string[], cwd: string): string | null {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Publish the package in `dir` under `name`.
 *
 * `npm publish` reads the name from package.json on disk, so shipping the
 * unscoped mirror means holding that one field rewritten for the length of one
 * command. The original bytes go back in a `finally`, so an interrupted or
 * failed publish cannot leave a rewritten manifest in the working tree — only
 * the tarball's copy differs, and only in `name`.
 */
function publishUnder(dir: string, name: string, manifestName: string): void {
  if (name === manifestName) {
    runInteractive("npm", ["publish", "--access", "public"], dir);
    return;
  }
  const manifestPath = join(dir, "package.json");
  const original = readFileSync(manifestPath, "utf8");
  const patched = JSON.parse(original) as PluginManifest;
  patched.name = name;
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`);
  try {
    runInteractive("npm", ["publish", "--access", "public"], dir);
  } finally {
    writeFileSync(manifestPath, original);
  }
}

function main(): void {
  const dryRun = process.argv.includes("--dry-run");
  const unknown = process.argv.slice(2).filter(
    (argument) => argument !== "--dry-run",
  );
  if (unknown.length > 0) {
    console.error(`publish: unknown argument${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`);
    process.exit(2);
  }

  const fail = (message: string): never => {
    console.error(`\n✗ ${message}`);
    process.exit(1);
  };

  const targets = publishableWorkspacePlugins(ROOT);
  console.log(
    `publishing ${targets.length} plugins (excluded: ${[...EXCLUDED].join(", ")})\n`,
  );

  // A stale dist/ is the failure mode that matters: the tarball is the product,
  // and a version stamp that disagrees with the manifest is refused at install.
  console.log("building every plugin…");
  run("bun", ["run", "build"], ROOT);

  const plans: {
    plugin: WorkspacePlugin;
    version: string;
    paths: string[];
  }[] = [];

  // Validate every tarball before publishing any of them. A broken package
  // late in the workspace must not turn a preventable validation failure into
  // a partial release.
  for (const plugin of targets) {
    const { directory: id, dir, manifest } = plugin;
    const version = manifest.version;
    if (typeof version !== "string" || version.trim() === "") {
      fail(`${id}: package.json has no version`);
    }
    if (!existsSync(join(dir, "LICENSE"))) fail(`${id}: no LICENSE in the package`);

    for (const artifact of ["server", ...(manifest.bb?.app ? ["app"] : [])]) {
      const metaPath = join(dir, "dist", `${artifact}.meta.json`);
      if (!existsSync(metaPath)) fail(`${id}: missing dist/${artifact}.meta.json — build first`);
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      if (meta.pluginVersion !== version) {
        fail(`${id}: dist/${artifact}.meta.json stamps ${meta.pluginVersion}, manifest says ${version}`);
      }
    }

    // `bun pm pack --dry-run` reports exactly the entries a real pack writes,
    // so this is the tarball's contents without producing one.
    const paths = packedPaths(run("bun", ["pm", "pack", "--dry-run"], dir));

    const problems = [
      ...publishProblems(manifest, paths),
      ...sourceClosureProblems(dir, manifest, paths),
    ];
    if (problems.length > 0) {
      fail(`${id} cannot be published:\n${problems.map((problem) => `    - ${problem}`).join("\n")}`);
    }

    plans.push({ plugin, version, paths });
  }

  for (const { plugin: { dir, name }, version, paths } of plans) {
    // The scoped name, then its unscoped mirror. Each is probed and published
    // on its own, so a mirror added to an already-released version still goes
    // out, and a half-finished run resumes without republishing what landed.
    const names = [name, mirrorPackageName(name)].filter(
      (candidate): candidate is string => candidate !== null,
    );
    for (const target of names) {
      const published = probe("npm", ["view", `${target}@${version}`, "version"], ROOT);
      if (published === version) {
        console.log(`  ${target}@${version} already published — skipping`);
        continue;
      }

      if (dryRun) {
        console.log(`  ${target}@${version} ready (${paths.length} files)`);
        continue;
      }

      console.log(`  publishing ${target}@${version}…`);
      // Scoped names publish RESTRICTED by default; this is what makes them public.
      publishUnder(dir, target, name);
      console.log(`  ✓ ${target}@${version}`);
    }
  }

  console.log(dryRun ? "\ndry run complete — nothing published" : "\ndone");
}

if (import.meta.main) main();
