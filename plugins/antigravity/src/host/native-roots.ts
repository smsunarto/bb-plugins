import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  experimental_filterResolvedNativeRoots,
  experimental_resolveVendorPluginRoots,
  type ExperimentalNativeRootsResolveAnswer,
  type ExperimentalNativeRootsResolveOutput,
  type ExperimentalVendorPlugin,
} from "@get-bb/plugin-sdk/host";

type ResolvedRootInput = NonNullable<ExperimentalNativeRootsResolveAnswer["skills"]>[number];
import { z } from "zod";

const manifestPathListSchema = z.union([z.string().min(1), z.array(z.string().min(1))]);

const agyPluginManifestSchema = z
  .object({
    name: z.string().min(1),
    skills: manifestPathListSchema.optional(),
    commands: manifestPathListSchema.optional(),
  })
  .passthrough();

const skillsJsonSchema = z.union([
  z.array(z.string().min(1)),
  z
    .object({
      paths: z.array(z.string().min(1)).optional(),
      skills: z
        .array(z.union([z.string().min(1), z.object({ path: z.string().min(1) }).passthrough()]))
        .optional(),
    })
    .passthrough(),
]);

type AgyPluginManifest = z.infer<typeof agyPluginManifestSchema>;

async function readJson<T>(filePath: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function readDirEntries(dirPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readPluginManifest(pluginRootPath: string): Promise<AgyPluginManifest | null> {
  for (const relativePath of ["plugin.json", path.join(".claude-plugin", "plugin.json")]) {
    const manifest = await readJson(
      path.join(pluginRootPath, relativePath),
      agyPluginManifestSchema,
    );
    if (manifest !== null) return manifest;
  }
  return null;
}

async function scanPluginDirectory(
  pluginsDir: string,
  origin: "user" | "project",
): Promise<ExperimentalVendorPlugin[]> {
  const entries = (await readDirEntries(pluginsDir))
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name));

  const plugins: ExperimentalVendorPlugin[] = [];
  for (const entry of entries) {
    const rootPath = path.join(pluginsDir, entry.name);
    const stat = await fs.stat(rootPath).catch(() => null);
    if (stat === null || !stat.isDirectory()) continue;
    const manifest = await readPluginManifest(rootPath);
    if (manifest === null) continue;
    plugins.push({
      rootPath,
      name: manifest.name,
      origin,
      ...(manifest.skills === undefined ? {} : { skills: manifest.skills }),
      ...(manifest.commands === undefined ? {} : { commands: manifest.commands }),
    });
  }
  return plugins;
}

function expandPath(rawPath: string, baseDir: string, homeDir: string): string {
  if (rawPath === "~") return homeDir;
  if (rawPath.startsWith("~/")) return path.join(homeDir, rawPath.slice(2));
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

async function scanSkillsJson(
  filePath: string,
  origin: "user" | "project",
  homeDir: string,
): Promise<ResolvedRootInput[]> {
  const data = await readJson(filePath, skillsJsonSchema);
  if (data === null) return [];
  const baseDir = path.dirname(filePath);
  const rawPaths: string[] = Array.isArray(data)
    ? data
    : [
        ...(data.paths ?? []),
        ...(data.skills ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path)),
      ];

  const roots: ResolvedRootInput[] = [];
  for (const rawPath of rawPaths) {
    const resolved = expandPath(rawPath, baseDir, homeDir);
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat === null || !stat.isDirectory()) continue;
    roots.push({ path: resolved, origin, shape: "skills" });
  }
  return roots;
}

async function deduplicatePlugins(
  plugins: readonly ExperimentalVendorPlugin[],
): Promise<ExperimentalVendorPlugin[]> {
  const result: ExperimentalVendorPlugin[] = [];
  const seen = new Set<string>();
  for (const plugin of plugins) {
    const key = await fs.realpath(plugin.rootPath).catch(() => plugin.rootPath);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(plugin);
  }
  return result;
}

export async function resolveAntigravityNativeRoots(args: {
  cwd: string | null;
  homeDir: string;
  warn?: (message: string) => void;
}): Promise<ExperimentalNativeRootsResolveOutput> {
  const projectPlugins =
    args.cwd === null
      ? []
      : [
          ...(await scanPluginDirectory(path.join(args.cwd, ".agents", "plugins"), "project")),
          ...(await scanPluginDirectory(path.join(args.cwd, ".agent", "plugins"), "project")),
        ];
  const userPlugins = await scanPluginDirectory(
    path.join(args.homeDir, ".gemini", "config", "plugins"),
    "user",
  );
  const plugins = await deduplicatePlugins([...projectPlugins, ...userPlugins]);

  const pluginRoots = await experimental_resolveVendorPluginRoots({
    plugins,
    layout: "claude",
  });

  const extraSkillRoots = [
    ...(args.cwd === null
      ? []
      : await scanSkillsJson(
          path.join(args.cwd, ".agents", "skills.json"),
          "project",
          args.homeDir,
        )),
    ...(await scanSkillsJson(
      path.join(args.homeDir, ".gemini", "config", "skills.json"),
      "user",
      args.homeDir,
    )),
  ];

  const filtered = experimental_filterResolvedNativeRoots(
    {
      skills: [...pluginRoots.skills, ...extraSkillRoots],
      commands: pluginRoots.commands,
    },
    {
      warn:
        args.warn ?? ((message) => process.stderr.write(`antigravity native-roots: ${message}\n`)),
    },
  );

  function normalizeResolvedRoot(
    root: ResolvedRootInput,
    defaultShape: "skills" | "commands",
  ): ExperimentalNativeRootsResolveOutput["skills"][number] {
    const normalized: ExperimentalNativeRootsResolveOutput["skills"][number] = {
      path: root.path,
      origin: root.origin,
      recursive: root.recursive ?? false,
      ancestors: root.ancestors ?? false,
      namePrefix: root.namePrefix ?? "",
      shape: root.shape ?? defaultShape,
    };
    if (root.fallbackName !== undefined) normalized.fallbackName = root.fallbackName;
    if (root.skipIfManifest !== undefined) normalized.skipIfManifest = root.skipIfManifest;
    return normalized;
  }

  // Normalize optional fields to the strict output contract.
  return {
    skills: filtered.answer.skills.map((root) => normalizeResolvedRoot(root, "skills")),
    commands: filtered.answer.commands.map((root) => normalizeResolvedRoot(root, "commands")),
  };
}
