/**
 * `bb review`: the reviewer's shared prompt and the review playbooks, global
 * and per project. Moved from the code-review plugin at the cutover; Source
 * Control registers it only once code-review no longer does.
 * Ported from `plugins/code-review/src/server/{command,lib/playbooks}.ts`.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import {
  cliCommand,
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  PluginCliError,
  type BbPluginApi,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import { parse } from "yaml";
import { z } from "zod";

const files = instructionFiles(import.meta.url);
/** What `bb review playbook` runs with: the host plus the invocation's thread and signal. */
export type CommandContext = Readonly<{ bb: BbPluginApi } & PluginCliContext>;

const directory = join(files.root, "playbooks");
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

function diagnostic(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

type IndexEntry = Pick<Awaited<ReturnType<typeof readPlaybook>>, "id" | "description">;

async function readIndex(ctx: CommandContext, locations: PlaybookLocation[]) {
  const playbooks: IndexEntry[] = [];
  const warnings: string[] = [];
  for (let start = 0; start < locations.length; start += 8) {
    const entries = await Promise.all(
      locations.slice(start, start + 8).map(async (location) => {
        try {
          const { id, description } = await readPlaybook(ctx, location);
          return { id, description };
        } catch (error) {
          return `${location.id}: ${diagnostic(error)}`.slice(0, 500);
        }
      }),
    );
    for (const entry of entries) {
      if (typeof entry === "string") warnings.push(entry);
      else playbooks.push(entry);
    }
  }
  return { playbooks, warnings };
}

function listResult({
  playbooks,
  warnings,
  json,
  offset,
  limit,
}: {
  playbooks: IndexEntry[];
  warnings: string[];
  json: boolean;
  offset: number;
  limit: number;
}) {
  let end = Math.min(playbooks.length, offset + limit);
  do {
    const nextOffset = end < playbooks.length ? end : null;
    const page = playbooks.slice(offset, end);
    const stdout = json
      ? JSON.stringify({ playbooks: page, warnings, nextOffset }) + "\n"
      : page.map(({ id, description }) => `${id} — ${description}`).join("\n") +
        "\n" +
        (nextOffset === null ? "" : `More playbooks: rerun with --offset ${nextOffset}.\n`);
    const stderr = json ? "" : warnings.map((warning) => `Warning: ${warning}\n`).join("");
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) <= PLUGIN_CLI_OUTPUT_MAX_BYTES)
      return { exitCode: 0, stdout, stderr };
    end--;
  } while (end > offset);
  throw new PluginCliError("This index entry exceeds the CLI byte limit.", {
    hint: "Read the playbook directly with --name <name>.",
  });
}

export function playbook(bb: BbPluginApi) {
  return cliCommand({
    summary: files.read("commands/playbook"),
    options: {
      name: { type: "string", description: files.read("commands/playbook-name") },
      machine: { type: "string", description: files.read("commands/playbook-machine") },
      directory: { type: "string", description: files.read("commands/playbook-directory") },
      json: { type: "boolean", description: files.read("commands/playbook-json") },
      offset: {
        type: "integer",
        min: 0,
        max: 1000000,
        default: 0,
        description: files.read("commands/playbook-offset"),
      },
      limit: {
        type: "integer",
        min: 1,
        max: 256,
        default: 50,
        description: files.read("commands/playbook-limit"),
      },
    },
    async run({ options }, cli) {
      const ctx: CommandContext = { bb, ...cli };
      const locations = await globalPlaybooks();
      const warnings: string[] = [];
      if (options.name === undefined || options.name.startsWith("project/")) {
        try {
          const project = await projectPlaybooks(ctx, options);
          locations.push(...project.locations);
          warnings.push(...project.warnings);
        } catch (error) {
          if (
            options.name !== undefined ||
            (error instanceof PluginCliError && error.code === "invalid_project_location")
          )
            throw error;
          warnings.push(`Project playbooks unavailable: ${diagnostic(error)}`);
        }
      }
      if (options.name !== undefined) {
        const location = locations.find((item) => item.id === options.name);
        if (!location)
          throw new PluginCliError(`Unknown review playbook: ${options.name}`, {
            hint: warnings[0] ?? "Run bb review playbook to list available names.",
          });
        try {
          const result = await readPlaybook(ctx, location);
          return {
            exitCode: 0,
            stdout: options.json ? JSON.stringify(result) + "\n" : result.content,
          };
        } catch (error) {
          throw new PluginCliError(`Cannot read ${location.id}: ${diagnostic(error)}`);
        }
      }
      const index = await readIndex(ctx, locations);
      return listResult({
        playbooks: index.playbooks,
        warnings: [...warnings, ...index.warnings],
        json: options.json ?? false,
        offset: options.offset,
        limit: options.limit,
      });
    },
  });
}

export function prompt() {
  return cliCommand({
    summary: files.read("commands/prompt"),
    options: {
      request: {
        type: "string",
        required: true,
        description: files.read("commands/prompt-request"),
      },
    },
    run({ options }) {
      if (!options.request.trim())
        throw new PluginCliError("The review request must not be empty.");
      const stdout = `${files.read("reviewer")}\n\n## Review request\n\n${options.request}\n`;
      if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES)
        throw new PluginCliError(
          "The review prompt exceeds the CLI byte limit. Shorten the request.",
        );
      return { exitCode: 0, stdout };
    },
  });
}
