import { cliCommand, PLUGIN_CLI_OUTPUT_MAX_BYTES, PluginCliError } from "@get-bb/plugin-sdk";
import { instructionFiles } from "@bb-plugins/instructions";
import type { CodeReviewContext } from "../lib/context.ts";
import {
  globalPlaybooks,
  projectPlaybooks,
  readPlaybook,
  type CommandContext,
  type PlaybookLocation,
} from "../lib/playbooks.ts";

const files = instructionFiles(import.meta.url);

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

export function playbook({ bb }: CodeReviewContext) {
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
