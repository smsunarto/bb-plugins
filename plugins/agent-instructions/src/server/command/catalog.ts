import { cliCommand } from "@get-bb/plugin-sdk";
import type { AgentInstructionsContext } from "../lib/context.ts";

export function catalogCommand(ctx: AgentInstructionsContext) {
  return cliCommand({
    summary: "Show the skills, global docs, and sync conflicts in the source folder",
    options: { json: { type: "boolean", description: "Print the catalog as JSON" } },
    async run({ options }) {
      await ctx.store.reloadFromDisk("disk");
      const skills = ctx.store.skills();
      const docs = ctx.store.docs().map((d) => ({
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        characters: d.body.length,
      }));
      const conflicts = ctx.store.conflicts();
      const revision = ctx.store.revision();
      const sourcePath = ctx.store.sourceDir;
      if (options.json) {
        return {
          exitCode: 0,
          stdout: `${JSON.stringify({ revision, sourcePath, docs, skills, conflicts }, null, 2)}\n`,
        };
      }
      if (skills.length === 0 && docs.length === 0 && conflicts.length === 0)
        return { exitCode: 0, stdout: "The catalog is empty\n" };
      const lines = [
        `Revision ${revision}  (${sourcePath})`,
        ...docs.map(
          (d) => `doc   ${d.id}  ${d.name}, ${d.characters} characters${d.enabled ? "" : " [off]"}`,
        ),
        ...skills.map(
          (s) =>
            `skill ${s.name}  ${s.files} files, ${(s.bytes / 1024).toFixed(0)} KiB${s.enabled ? "" : " [off]"}${s.error ? `  [invalid: ${s.error}]` : ""}`,
        ),
        ...conflicts.map((c) => `conflict  ${c}`),
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });
}
