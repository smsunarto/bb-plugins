import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  cliCommand,
  PluginCliError,
  type PluginCliCommand,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { catalogChange, type CatalogChange } from "../../catalog/contract.ts";
import type { CatalogContext } from "../../catalog/import.ts";
import type { catalogHandlers } from "../../catalog/rpc.ts";
import { callerHost } from "../lib/targets.ts";

type Handlers = ReturnType<typeof catalogHandlers>;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const asJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Commands that read and change catalog skills and global docs, for agents.
 * They go through the editor's handlers, so a change is checked, stored and
 * published exactly as a save in the Global tab is. Every change names the
 * sha256 it replaces, so an edit made elsewhere is never overwritten.
 */
export function editCommands(ctx: CatalogContext, handlers: Handlers) {
  const json = { type: "boolean", description: "Print the result as JSON" } as const;
  const expect = {
    type: "string",
    required: true,
    placeholder: "sha256",
    description: "The sha256 that `show` printed, so a change made since then is not overwritten",
  } as const;
  // A file keeps its exact bytes and has no argv size limit; --content suits short text.
  const source = {
    file: {
      type: "string",
      placeholder: "path",
      description: "Read the whole new text from this file, stored exactly as it is",
    },
    content: {
      type: "string",
      placeholder: "text",
      description: "The whole new text, instead of --file",
    },
    host: {
      type: "string",
      placeholder: "host-id",
      description: "Host that has --file. Defaults to this thread's host",
    },
  } as const;

  /** The new text: --content as given, or --file read on the calling thread's host. */
  async function newText(
    options: { file?: string | undefined; content?: string | undefined; host?: string | undefined },
    context: PluginCliContext,
  ) {
    if ((options.file === undefined) === (options.content === undefined))
      throw new PluginCliError("Pass the new text with exactly one of --file or --content", {
        code: "invalid",
      });
    if (options.content !== undefined) return options.content;
    const file = posix.resolve(context.cwd ?? "/", options.file ?? "");
    const hostId = options.host ?? (await callerHost(ctx.bb, context.threadId));
    if (!hostId)
      throw new PluginCliError("--file needs --host outside a bb thread", { code: "no_host" });
    const { content } = await ctx.host.call(
      "readText",
      { rootPath: posix.dirname(file), path: posix.basename(file) },
      { hostId, timeoutMs: 60_000 },
    );
    if (content === null)
      throw new PluginCliError(`${file} does not exist on host ${hostId}`, { code: "no_file" });
    return content;
  }

  function skill(name: string) {
    const found = ctx.catalog.listing().skills.find((s) => s.name === name);
    if (!found)
      throw new PluginCliError(`No skill ${name} in the catalog`, {
        code: "unknown_skill",
        hint: "List skills with `bb agent-instructions catalog`",
      });
    return found;
  }

  function doc(id: string) {
    const found = ctx.catalog.listing().docs.find((d) => d.id === id);
    if (!found)
      throw new PluginCliError(`No doc ${id} in the catalog`, {
        code: "unknown_doc",
        hint: "List doc ids with `bb agent-instructions catalog`",
      });
    return found;
  }

  /** Reads a file the way the editor opens it. `content` is null for a binary file. */
  function read(target: { skill: string; path: string } | { doc: string }) {
    const file = handlers.catalogFile(target);
    const label = "doc" in target ? target.doc : `${target.skill}/${target.path}`;
    if (file.sha256 === null)
      throw new PluginCliError(`${label} does not exist`, {
        code: "unknown_file",
        hint: "Create it with `skill write` and `--expect new`",
      });
    return { ...file, sha256: file.sha256 };
  }

  /** Text mode prints only text; `--json` still gives a binary file's sha256 for a delete. */
  function textOf(file: { content: string | null }, label: string) {
    if (file.content === null)
      throw new PluginCliError(`${label} is not a text file`, {
        code: "not_text",
        hint: "Pass --json for its sha256",
      });
    return file.content;
  }

  /**
   * Parses a change at this boundary, applies it, and reports the outcome. A
   * change that saved but did not publish exits 1, since new threads will not
   * see it until `publish` succeeds.
   */
  async function apply(input: unknown, label: string, json: boolean | undefined) {
    const parsed = catalogChange.safeParse(input);
    if (!parsed.success)
      throw new PluginCliError(
        parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        { code: "invalid", hint: "--expect takes the 64-character sha256 that `show` printed" },
      );
    const result = await handlers.changeCatalog(parsed.data satisfies CatalogChange);
    if (result.outcome === "conflict")
      throw new PluginCliError(result.message, {
        code: "conflict",
        hint: "Run `show` again, merge your change, and pass its sha256 to --expect",
      });
    if (result.outcome === "invalid")
      throw new PluginCliError(result.errors.join("\n"), { code: "invalid" });
    const published = result.published;
    const failed = !published.ok || published.problems.length > 0;
    const exitCode = failed ? 1 : 0;
    if (json) return { exitCode, stdout: asJson(result) };
    const hashes = [
      result.sha256 && `sha256 ${result.sha256}`,
      result.treeSha && `tree sha256 ${result.treeSha}`,
    ].filter(Boolean);
    const lines = [
      `${label}: saved as revision ${result.revision}${hashes.map((h) => `, ${h}`).join("")}`,
      ...result.warnings.map((w) => `warning: ${w}`),
      ...(published.ok ? published.warnings.map((w) => `publish warning: ${w}`) : []),
    ];
    if (!failed)
      return { exitCode, stdout: `${[...lines, "Published for new threads"].join("\n")}\n` };
    const problems = published.ok ? published.problems : [published.error];
    return {
      exitCode,
      stdout: `${lines.join("\n")}\n`,
      stderr:
        `Saved, but not published: ${problems.join("; ")}\n` +
        "New threads keep the previous version. Fix the problem, then run `bb agent-instructions publish`\n",
    };
  }

  /** Writing back what `show` printed would add a revision and make an imported entry authored. */
  const unchanged = (text: string, expected: string, label: string, json: boolean | undefined) =>
    sha256(text) !== expected
      ? null
      : {
          exitCode: 0,
          stdout: json
            ? asJson({ outcome: "unchanged", sha256: expected })
            : `${label}: unchanged; nothing saved\n`,
        };

  const commands: Record<string, PluginCliCommand> = {
    "skill show": cliCommand({
      summary: "Print a catalog skill's file; stderr has the sha256 to pass to --expect",
      positionals: [
        { name: "name", description: "Skill name", required: true },
        { name: "path", description: "File in the skill. Defaults to SKILL.md" },
      ],
      options: { json },
      async run({ positionals, options }) {
        const found = skill(positionals.name);
        const path = positionals.path ?? "SKILL.md";
        const label = `${found.name}/${path}`;
        const file = read({ skill: found.name, path });
        const files = found.files.map((f) => f.path);
        if (options.json)
          return {
            exitCode: 0,
            stdout: asJson({ skill: found.name, path, ...file, treeSha: found.treeSha, files }),
          };
        return {
          exitCode: 0,
          stdout: textOf(file, label),
          stderr:
            `${label}: sha256 ${file.sha256}\n` +
            `${found.name}: tree sha256 ${found.treeSha}; files ${files.join(", ")}\n`,
        };
      },
    }),

    "skill create": cliCommand({
      summary: "Create a catalog skill with a starter SKILL.md, then edit it with `skill write`",
      positionals: [
        {
          name: "name",
          description: "Lowercase letters, digits and single hyphens",
          required: true,
        },
      ],
      options: {
        description: {
          type: "string",
          required: true,
          placeholder: "text",
          description: "What the skill does and when to use it",
        },
        json,
      },
      run: ({ positionals, options }) =>
        apply(
          { op: "createSkill", name: positionals.name, description: options.description },
          `${positionals.name.trim()}/SKILL.md`,
          options.json,
        ),
    }),

    "skill write": cliCommand({
      summary: "Replace or create one file of a catalog skill",
      positionals: [
        { name: "name", description: "Skill name", required: true },
        { name: "path", description: "File in the skill, such as SKILL.md", required: true },
      ],
      options: {
        ...source,
        expect: { ...expect, description: `${expect.description}; \`new\` creates the file` },
        json,
      },
      async run({ positionals, options }, context) {
        const name = skill(positionals.name).name;
        const label = `${name}/${positionals.path}`;
        const content = await newText(options, context);
        return (
          unchanged(content, options.expect, label, options.json) ??
          apply(
            {
              op: "saveFile",
              skill: name,
              path: positionals.path,
              content,
              expectedSha256: options.expect === "new" ? null : options.expect,
            },
            label,
            options.json,
          )
        );
      },
    }),

    "skill delete": cliCommand({
      summary: "Delete a file of a catalog skill, or the whole skill when no path is given",
      positionals: [
        { name: "name", description: "Skill name", required: true },
        { name: "path", description: "File to delete. Omit it to delete the skill" },
      ],
      options: {
        expect: {
          ...expect,
          description: `${expect.description}: the file's sha256, or the skill's tree sha256`,
        },
        json,
      },
      run({ positionals, options }) {
        const name = skill(positionals.name).name;
        const path = positionals.path;
        return path === undefined
          ? apply({ op: "deleteSkill", name, expectedTreeSha: options.expect }, name, options.json)
          : apply(
              { op: "deleteFile", skill: name, path, expectedSha256: options.expect },
              `${name}/${path}`,
              options.json,
            );
      },
    }),

    "doc show": cliCommand({
      summary: "Print a global instructions doc; stderr has the sha256 to pass to --expect",
      positionals: [{ name: "id", description: "Doc id from `catalog`", required: true }],
      options: { json },
      async run({ positionals, options }) {
        const found = doc(positionals.id);
        const file = read({ doc: found.id });
        if (options.json)
          return {
            exitCode: 0,
            stdout: asJson({ id: found.id, name: found.name, enabled: found.enabled, ...file }),
          };
        return {
          exitCode: 0,
          stdout: textOf(file, found.id),
          stderr: `${found.id} (${found.name}): sha256 ${file.sha256}\n`,
        };
      },
    }),

    "doc write": cliCommand({
      summary: "Replace the text of a global instructions doc",
      positionals: [{ name: "id", description: "Doc id from `catalog`", required: true }],
      options: { ...source, expect, json },
      async run({ positionals, options }, context) {
        const id = doc(positionals.id).id;
        // Docs are stored trimmed, as the import stores them, so an editor's final newline is no change.
        const body = (await newText(options, context)).trim();
        return (
          unchanged(body, options.expect, id, options.json) ??
          apply({ op: "saveDoc", id, body, expectedSha256: options.expect }, id, options.json)
        );
      },
    }),

    "doc delete": cliCommand({
      summary: "Delete a global instructions doc; the Global tab can restore it",
      positionals: [{ name: "id", description: "Doc id from `catalog`", required: true }],
      options: { expect, json },
      run: ({ positionals, options }) => {
        const id = doc(positionals.id).id;
        return apply({ op: "deleteDoc", id, expectedSha256: options.expect }, id, options.json);
      },
    }),
  };
  return commands;
}
