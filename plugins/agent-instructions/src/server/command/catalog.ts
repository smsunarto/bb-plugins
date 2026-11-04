import { cliCommand } from "@get-bb/plugin-sdk";
import type { CatalogContext } from "../../catalog/import.ts";

export function catalogCommand(ctx: CatalogContext) {
  return cliCommand({
    summary: "Show the skills and global instructions stored in the catalog",
    options: { json: { type: "boolean", description: "Print the catalog as JSON" } },
    async run({ options }) {
      const skills = ctx.catalog.skills();
      const docs = ctx.catalog.docs().map((d) => ({
        id: d.id,
        name: d.name,
        enabled: d.enabled,
        origin: d.origin,
        rev: d.rev,
        characters: d.body.length,
      }));
      const revision = ctx.catalog.revision();
      if (options.json)
        return { exitCode: 0, stdout: `${JSON.stringify({ revision, docs, skills }, null, 2)}\n` };
      if (skills.length === 0 && docs.length === 0)
        return { exitCode: 0, stdout: "The catalog is empty\n" };
      const lines = [
        `Revision ${revision}`,
        ...docs.map(
          (d) => `doc   ${d.id}  ${d.name}, ${d.characters} characters${d.enabled ? "" : " [off]"}`,
        ),
        ...skills.map(
          (s) =>
            `skill ${s.name}  ${s.files} files, ${(s.bytes / 1024).toFixed(0)} KiB${s.enabled ? "" : " [off]"}` +
            (s.origin.kind === "imported" ? `  from ${s.origin.from}` : ""),
        ),
      ];
      return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
    },
  });
}
