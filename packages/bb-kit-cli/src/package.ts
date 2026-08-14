import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import type { Diagnostic } from "./check.js";
import type { PluginManifest } from "./project.js";

interface ManifestTarget {
  readonly label: string;
  readonly entry: string;
  readonly tree: boolean;
}

function diagnostic(
  code: string,
  message: string,
  hint: string,
  file?: string,
): Diagnostic {
  return {
    code,
    severity: "error",
    message,
    hint,
    ...(file === undefined ? {} : { file }),
  };
}

function packagePath(entry: string): string {
  return normalize(entry.replace(/^\.\/+/, "").replace(/\/\*$/, ""))
    .replaceAll("\\", "/")
    .replace(/\/+$/, "");
}

function isPackagePath(path: string): boolean {
  return path !== ""
    && path !== "."
    && !isAbsolute(path)
    && path !== ".."
    && !path.startsWith("../");
}

/** Parse Bun's dry-run pack listing and reject silent format drift. */
export function packedPaths(output: string): string[] {
  const paths: string[] = [];
  let total: number | null = null;
  for (const line of output.split("\n")) {
    const packed = /^\s*packed\s+\S+\s+(.+?)\s*$/.exec(line);
    if (packed?.[1]) paths.push(packed[1]);
    const summary = /^\s*Total files:\s*(\d+)\s*$/.exec(line);
    if (summary?.[1]) total = Number(summary[1]);
  }
  if (total === null) {
    throw new Error("bun pack output has no Total files summary");
  }
  if (paths.length !== total) {
    throw new Error(
      `bun pack listed ${paths.length} files but reported ${total}`,
    );
  }
  return paths;
}

function manifestTargets(manifest: PluginManifest): ManifestTarget[] {
  const targets: ManifestTarget[] = [];
  const addFile = (label: string, entry: unknown): void => {
    if (typeof entry === "string" && entry.trim() !== "") {
      targets.push({ label, entry, tree: false });
    }
  };
  const bb = manifest.bb ?? {};
  addFile("bb.server", bb.server);
  addFile("bb.app", bb.app);

  const branding = typeof bb.branding === "object" && bb.branding !== null
    ? bb.branding as Record<string, unknown>
    : {};
  const icon = branding.icon;
  if (typeof icon === "string" && icon.startsWith("./")) {
    addFile("bb.branding.icon", icon);
  }
  const logo = typeof branding.logo === "object" && branding.logo !== null
    ? branding.logo as Record<string, unknown>
    : {};
  addFile("bb.branding.logo.light", logo.light);
  addFile("bb.branding.logo.dark", logo.dark);

  if (Array.isArray(bb.themes)) {
    for (const [index, value] of bb.themes.entries()) {
      if (typeof value !== "object" || value === null) continue;
      addFile(`bb.themes[${index}].css`, (value as Record<string, unknown>).css);
    }
  }
  for (const field of ["skills", "commands"] as const) {
    const value = bb[field];
    const entries = typeof value === "string"
      ? [value]
      : Array.isArray(value) ? value : [];
    for (const entry of entries) {
      if (typeof entry === "string" && entry.trim() !== "") {
        targets.push({ label: `bb.${field}`, entry, tree: true });
      }
    }
  }
  return targets;
}

function resolveSourceImport(root: string, from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(root, specifier.slice(2))
    : join(dirname(from), specifier);
  const withoutCompiledExtension = base.endsWith(".js")
    ? base.slice(0, -3)
    : base.endsWith(".jsx") ? base.slice(0, -4) : base;
  const candidates = [
    base,
    `${withoutCompiledExtension}.ts`,
    `${withoutCompiledExtension}.tsx`,
    `${withoutCompiledExtension}.js`,
    `${withoutCompiledExtension}.jsx`,
    `${withoutCompiledExtension}.css`,
    join(withoutCompiledExtension, "index.ts"),
    join(withoutCompiledExtension, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function sourceClosureDiagnostics(
  root: string,
  manifest: PluginManifest,
  packed: ReadonlySet<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const queue = [manifest.bb?.server, manifest.bb?.app]
    .filter((entry): entry is string => typeof entry === "string" && entry !== "")
    .map(packagePath)
    .filter(isPackagePath);
  const seen = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!packed.has(file)) {
      diagnostics.push(diagnostic(
        "BBK405",
        `packed source fallback omits "${file}"`,
        "Add the file to package.json files; bb may load shipped source when a bundle is absent or SDK-incompatible.",
        file,
      ));
      continue;
    }
    if (/\.(?:css|json)$/.test(file)) continue;
    const absolute = join(root, file);
    if (!existsSync(absolute)) continue;
    const source = readFileSync(absolute, "utf8");
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\(\s*|import\s*)["']([^"']+)["']/g,
    )) {
      const specifier = match[1];
      if (!specifier || (!specifier.startsWith(".") && !specifier.startsWith("@/"))) {
        continue;
      }
      const resolved = resolveSourceImport(root, absolute, specifier);
      if (!resolved) continue;
      const relativePath = relative(root, resolved).replaceAll("\\", "/");
      if (!seen.has(relativePath)) queue.push(relativePath);
    }
  }
  return diagnostics;
}

/** Validate the package bb will actually install, not merely source files. */
export function checkPackedPackage(
  root: string,
  manifest: PluginManifest,
  paths: readonly string[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const packed = new Set(paths);
  for (const target of manifestTargets(manifest)) {
    const wanted = packagePath(target.entry);
    if (!isPackagePath(wanted)) {
      diagnostics.push(diagnostic(
        "BBK402",
        `${target.label} target "${target.entry}" is outside the package`,
        "Use a package-relative path without parent-directory segments.",
        "package.json",
      ));
      continue;
    }
    const present = target.tree
      ? paths.some((path) => path === wanted || path.startsWith(`${wanted}/`))
      : packed.has(wanted);
    if (!present) {
      diagnostics.push(diagnostic(
        "BBK403",
        `${target.label} target "${target.entry}" is absent from the package`,
        "Add the target to package.json files before publishing or installing the plugin.",
        "package.json",
      ));
    }
  }

  const fixed = ["dist/server.meta.json"];
  if (manifest.bb?.app) fixed.push("dist/app.js", "dist/app.meta.json");
  for (const file of fixed) {
    if (!packed.has(file)) {
      diagnostics.push(diagnostic(
        "BBK404",
        `built package is missing "${file}"`,
        "Run a successful bb plugin build and ensure dist/ is included in package.json files.",
        "package.json",
      ));
    }
  }
  if (!packed.has("LICENSE")) {
    diagnostics.push(diagnostic(
      "BBK406",
      "built package has no LICENSE",
      "Add LICENSE to the package files allowlist.",
      "package.json",
    ));
  }
  diagnostics.push(...sourceClosureDiagnostics(root, manifest, packed));
  return diagnostics.sort((left, right) =>
    `${left.file ?? ""}:${left.code}:${left.message}`.localeCompare(
      `${right.file ?? ""}:${right.code}:${right.message}`,
    ),
  );
}
