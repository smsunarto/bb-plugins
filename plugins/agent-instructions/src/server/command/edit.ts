import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  cliCommand,
  PluginCliError,
  type PluginCliCommand,
  type PluginCliContext,
} from "@get-bb/plugin-sdk";
import { catalogChange, type CatalogChange } from "../../catalog/contract.ts";
import { MAX_FILE_BYTES } from "../../catalog/edit-rules.ts";
import type { catalogHandlers } from "../../catalog/rpc.ts";
import type { AgentInstructionsContext } from "../lib/context.ts";
import { callerEnvironment } from "../lib/targets.ts";

type Handlers = ReturnType<typeof catalogHandlers>;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const asJson = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && /ENOENT|Path does not exist|not found/i.test(error.message);
}

/**
 * Thin CLI wrappers over the file-backed catalog handlers.
 * Agents can also edit files directly in the folder returned by `bb agent-instructions path`.
 */
export function editCommands(ctx: AgentInstructionsContext, handlers: Handlers) {
  const json = { type: "boolean", description: "Print the result as JSON" } as const;
  const expect = {
    type: "string",
    required: true,
    placeholder: "sha256",
    description: "The sha256 that `show` printed, so a change made since then is not overwritten",
  } as const;
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
      description: "Host that has --file (outside a bb thread; threads always use their own host)",
    },
  } as const;

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
    const env = await callerEnvironment(ctx.bb, context.threadId);
    const threadHost = env?.hostId;
    if (context.threadId && options.host && options.host !== threadHost) {
      throw new PluginCliError("Cannot override --host to another host from inside a bb thread", {
        code: "forbidden_host",
      });
    }
    const hostId = threadHost ?? options.host;
    if (!hostId)
      throw new PluginCliError("--file needs --host outside a bb thread", { code: "no_host" });

    let rootPath: string;
    if (context.threadId) {
      // Confine thread `--file` reads to the thread's workspace or this host's editable instructions root.
      const trustedRoots: string[] = [];
      if (env?.path) trustedRoots.push(posix.resolve(env.path));
      const editable = await ctx.sync.editablePathForHost(hostId).catch(() => null);
      if (editable?.path) trustedRoots.push(posix.resolve(editable.path));
      const matched = trustedRoots.find(
        (root) => file === root || file.startsWith(root.endsWith("/") ? root : `${root}/`),
      );
      if (!matched) {
        throw new PluginCliError(
          `${file} is outside this thread's workspace and editable instructions folder`,
          { code: "forbidden_path" },
        );
      }
      rootPath = matched;
    } else {
      rootPath = posix.dirname(file);
    }

    let read;
    try {
      read = await ctx.bb.sdk.files.read({
        hostId,
        path: file,
        rootPath,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new PluginCliError(`${file} does not exist on host ${hostId}`, { code: "no_file" });
      }
      throw error;
    }
    if (read.contentEncoding !== "utf8") {
      throw new PluginCliError(`${file} is not a UTF-8 text file`, { code: "not_text" });
    }
    if (read.sizeBytes > MAX_FILE_BYTES) {
      throw new PluginCliError(`${file} exceeds the ${MAX_FILE_BYTES}-byte editor limit`, {
        code: "too_large",
      });
    }
    return read.content;
  }

  async function skill(name: string) {
    await ctx.store.reloadFromDisk("disk");
    const found = ctx.store.findSkill(name);
    if (!found)
      throw new PluginCliError(`No skill ${name} in the catalog`, {
        code: "unknown_skill",
        hint: "List skills with `bb agent-instructions catalog`",
      });
    return found;
  }

  async function doc(id: string) {
    await ctx.store.reloadFromDisk("disk");
    const found = ctx.store.findDoc(id);
    if (!found)
      throw new PluginCliError(`No doc ${id} in the catalog`, {
        code: "unknown_doc",
        hint: "List doc ids with `bb agent-instructions catalog`",
      });
    return found;
  }

  async function read(target: { skill: string; path: string } | { doc: string }) {
    const file = await handlers.catalogFile(target);
    const label = "doc" in target ? target.doc : `${target.skill}/${target.path}`;
    if (file.sha256 === null)
      throw new PluginCliError(`${label} does not exist`, {
        code: "unknown_file",
        hint: "Create it with `skill write` and `--expect new`",
      });
    return { ...file, sha256: file.sha256 };
  }

  function textOf(file: { content: string | null }, label: string) {
    if (file.content === null)
      throw new PluginCliError(`${label} is not a text file`, {
        code: "not_text",
        hint: "Pass --json for its sha256",
      });
    return file.content;
  }

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

  const unchanged = (label: string, expected: string, json: boolean | undefined) => ({
    exitCode: 0,
    stdout: json
      ? asJson({ outcome: "unchanged", sha256: expected })
      : `${label}: unchanged; nothing saved\n`,
  });

  const commands: Record<string, PluginCliCommand> = {
    "skill show": cliCommand({
      summary: "Print a catalog skill's file; stderr has the sha256 to pass to --expect",
      positionals: [
        { name: "name", description: "Skill name", required: true },
        { name: "path", description: "File in the skill. Defaults to SKILL.md" },
      ],
      options: { json },
      async run({ positionals, options }) {
        const found = await skill(positionals.name);
        const path = positionals.path ?? "SKILL.md";
        const label = `${found.name}/${path}`;
        const file = await read({ skill: found.name, path });
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
      summary: "Create a catalog skill with a starter SKILL.md",
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
        const name = (await skill(positionals.name)).name;
        const label = `${name}/${positionals.path}`;
        const content = await newText(options, context);
        if (sha256(content) === options.expect)
          return unchanged(label, options.expect, options.json);
        return apply(
          {
            op: "saveFile",
            skill: name,
            path: positionals.path,
            content,
            expectedSha256: options.expect === "new" ? null : options.expect,
          },
          label,
          options.json,
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
      async run({ positionals, options }) {
        const name = (await skill(positionals.name)).name;
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
        const found = await doc(positionals.id);
        const file = await read({ doc: found.id });
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
        const found = await doc(positionals.id);
        const body = (await newText(options, context)).trim();
        const current = await read({ doc: found.id });
        if (current.sha256 === options.expect && current.content?.trim() === body)
          return unchanged(found.id, options.expect, options.json);
        return apply(
          { op: "saveDoc", id: found.id, body, expectedSha256: options.expect },
          found.id,
          options.json,
        );
      },
    }),

    "doc delete": cliCommand({
      summary: "Delete a global instructions doc; the Global tab can restore it",
      positionals: [{ name: "id", description: "Doc id from `catalog`", required: true }],
      options: { expect, json },
      async run({ positionals, options }) {
        const id = (await doc(positionals.id)).id;
        return apply({ op: "deleteDoc", id, expectedSha256: options.expect }, id, options.json);
      },
    }),
  };
  return commands;
}
