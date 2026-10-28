import { readdir, readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import { PluginCliError, type BbPluginApi, type PluginCliContext } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { parse } from "yaml";
import { z } from "zod";

/** What `bb review playbook` runs with: the host plus the invocation's thread and signal. */
export type CommandContext = Readonly<{ bb: BbPluginApi } & PluginCliContext>;

const directory = join(instructionFiles(import.meta.url).root, "playbooks");
const metadata = z.object({ description: z.string().trim().min(1).max(1000) });
const missing = z.object({ code: z.literal("ENOENT") });
const maxBytes = 64 * 1024;
const maxFiles = 256;

export type PlaybookLocation =
  | { scope: "global"; id: string; path: string }
  | { scope: "project"; id: string; path: string; rootPath: string; hostId: string };

export async function globalPlaybooks(): Promise<PlaybookLocation[]> {
  return (await readdir(directory))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      scope: "global",
      id: `global/${name.slice(0, -3)}`,
      path: join(directory, name),
    }));
}

async function projectCheckout(
  ctx: CommandContext,
  options: { machine?: string; directory?: string },
): Promise<{ hostId: string; root: string } | null> {
  if (options.machine !== undefined || options.directory !== undefined) {
    if (!options.machine || !options.directory) {
      throw new PluginCliError("Project playbooks require both --machine and --directory.", {
        code: "invalid_project_location",
      });
    }
    return { hostId: options.machine, root: options.directory };
  }
  if (!ctx.threadId) return null;
  const thread = await ctx.bb.sdk.threads.get({ threadId: ctx.threadId });
  if (!thread.environmentId) return null;
  const environment = await ctx.bb.sdk.environments.get({ environmentId: thread.environmentId });
  if (!environment.hostId || !environment.path) {
    throw new PluginCliError("This checkout has no execution machine or path.");
  }
  return { hostId: environment.hostId, root: environment.path };
}

export async function projectPlaybooks(
  ctx: CommandContext,
  options: { machine?: string; directory?: string },
): Promise<{ locations: PlaybookLocation[]; warnings: string[] }> {
  const checkout = await projectCheckout(ctx, options);
  if (!checkout) {
    return {
      locations: [],
      warnings: [
        "Project playbooks need a BB thread with a checkout, or --machine <id> --directory <absolute-checkout>.",
      ],
    };
  }
  const { hostId, root } = checkout;
  const paths = root.startsWith("/") ? posix : win32;
  if (!paths.isAbsolute(root))
    throw new PluginCliError("--directory must be an absolute path.", {
      code: "invalid_project_location",
    });
  const rootPath = paths.join(root, ".agents", "review");
  let listed;
  try {
    listed = await ctx.bb.sdk.files.list({
      hostId,
      path: rootPath,
      limit: maxFiles,
      signal: ctx.signal,
    });
  } catch (error) {
    if (missing.safeParse(error).success) return { locations: [], warnings: [] };
    throw error;
  }
  if (listed.truncated) {
    throw new PluginCliError(`Project playbook listing exceeds ${maxFiles} files: ${rootPath}`);
  }
  const locations: PlaybookLocation[] = [];
  for (const file of listed.files) {
    const relative = file.path.replaceAll("\\", "/");
    if (!relative.endsWith(".md")) continue;
    if (
      posix.isAbsolute(relative) ||
      relative.split("/").some((part) => part === ".." || part === ".") ||
      win32.isAbsolute(relative)
    ) {
      throw new PluginCliError(`Invalid project playbook path: ${file.path}`);
    }
    locations.push({
      scope: "project",
      id: `project/${relative.slice(0, -3)}`,
      path: paths.join(rootPath, file.path),
      rootPath,
      hostId,
    });
  }
  return { locations: locations.sort((a, b) => a.id.localeCompare(b.id)), warnings: [] };
}

export async function readPlaybook(ctx: CommandContext, location: PlaybookLocation) {
  let content: string;
  if (location.scope === "global") {
    content = await readFile(location.path, "utf8");
  } else {
    const file = await ctx.bb.sdk.files.read({
      hostId: location.hostId,
      rootPath: location.rootPath,
      path: location.path,
      signal: ctx.signal,
    });
    if (file.contentEncoding !== "utf8") throw new Error("Playbooks must be UTF-8 Markdown.");
    content = file.content;
  }
  if (Buffer.byteLength(content) > maxBytes) throw new Error("Playbooks must be at most 64 KiB.");
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  if (!frontmatter) throw new Error("Playbooks need YAML frontmatter with a description.");
  const parsed: unknown = parse(frontmatter[1]!, { maxAliasCount: 20 });
  const { description } = metadata.parse(parsed);
  return { id: location.id, description: description.replace(/\s+/g, " "), content };
}
