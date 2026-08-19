import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TaskId } from "./contract.js";
import type { DotfilesService } from "./service.js";

const checkTasks: Readonly<Record<string, TaskId>> = {
  location: "check:location",
  mise: "check:mise",
  shell: "check:shell",
  mcp: "check:mcp",
  python: "check:python",
  skills: "check:skills",
  dotfiles: "check:dotfiles",
  safety: "check:safety",
  secrets: "check:secrets",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDotfilesCli(cli: BbPluginApi["cli"], service: DotfilesService): void {
  cli.register({
    name: "dotfiles",
    summary: "Manage the tweakable dotfiles repo (list, status, cat, render, check, sync)",
    commands: [
      {
        name: "list",
        summary: "List tweakable files with dirty markers",
        usage: "bb dotfiles list",
      },
      {
        name: "status",
        summary: "Git status of the dotfiles repo",
        usage: "bb dotfiles status",
      },
      {
        name: "cat",
        summary: "Print a tweakable file",
        usage: "bb dotfiles cat <repo-relative-path>",
      },
      {
        name: "render",
        summary: "Render agent configs and settings overlays via mise",
        usage: "bb dotfiles render",
      },
      {
        name: "check",
        summary: "Run all validation or one named check target",
        usage: "bb dotfiles check [target]",
      },
      {
        name: "sync",
        summary: "Sync the repo; default is consume-only, --publish pushes",
        usage: "bb dotfiles sync [--publish]",
      },
    ],
    async run(argv) {
      try {
        const [command, ...rest] = argv;
        const overview = await service.overview(null);
        if (!overview.repoExists) {
          return {
            exitCode: 1,
            stderr: `dotfiles repo not found at ${overview.repoPath}`,
          };
        }

        switch (command) {
          case "list": {
            const lines: string[] = [];
            for (const group of overview.groups) {
              lines.push(`# ${group.title}`);
              for (const file of group.files) {
                const flags = [
                  file.dirty ? "dirty" : "",
                  file.render ? "renders" : "",
                  file.exists ? "" : "MISSING",
                ]
                  .filter(Boolean)
                  .join(", ");
                lines.push(`  ${file.path}${flags ? `  [${flags}]` : ""}`);
              }
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          }
          case "status": {
            const body = overview.gitEntries
              .map((entry) => `${entry.status.padEnd(2)} ${entry.path}`)
              .join("\n");
            return {
              exitCode: 0,
              stdout: `branch: ${overview.branch}\n${body || "clean"}`,
            };
          }
          case "cat": {
            const path = rest[0];
            if (!path) {
              return {
                exitCode: 2,
                stderr: "usage: bb dotfiles cat <repo-relative-path>",
              };
            }
            const file = await service.readFile({ path });
            return { exitCode: 0, stdout: file.content };
          }
          case "render": {
            const result = await service.runTask({ task: "render" });
            return { exitCode: result.exitCode, stdout: result.output };
          }
          case "check": {
            const target = rest[0];
            const task = target === undefined ? "check" : checkTasks[target];
            if (task === undefined) {
              return { exitCode: 2, stderr: `unknown check target: ${target}` };
            }
            const result = await service.runTask({ task });
            return { exitCode: result.exitCode, stdout: result.output };
          }
          case "sync": {
            const result = rest.includes("--publish")
              ? await service.publish(null)
              : await service.runTask({ task: "sync:pull" });
            return { exitCode: result.exitCode, stdout: result.output };
          }
          default:
            return {
              exitCode: 2,
              stderr:
                "usage: bb dotfiles <list|status|cat|render|check|sync>\n" +
                "  list              list tweakable files\n" +
                "  status            git status of the repo\n" +
                "  cat <path>        print a tweakable file\n" +
                "  render            render agent configs and settings overlays\n" +
                "  check [target]    run validation (location|mise|shell|mcp|python|skills|dotfiles|safety|secrets)\n" +
                "  sync [--publish]  pull-only sync, or publish with --publish",
            };
        }
      } catch (error) {
        return { exitCode: 1, stderr: errorMessage(error) };
      }
    },
  });
}
