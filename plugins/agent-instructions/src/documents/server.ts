import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { posix } from "node:path";
import { z } from "zod";
import {
  documentBoundary,
  documentHostContract,
  MAX_TEXT_BYTES,
  textExtensions,
  type DocumentSource,
  type DocumentFile,
} from "./model.ts";

const GLOBAL_KEY = "global-project";
const managedSkill = (path: string) =>
  path === ".dotfiles/.agents/skills/bb-cli/SKILL.md" ||
  path.startsWith(".dotfiles/.agents/skills/bb-cli/");
function missing(error: unknown) {
  return error instanceof Error && /ENOENT|Path does not exist/.test(error.message);
}

export function relativeDocumentQuery(root: string, query: string | undefined): string | undefined {
  if (!query) return undefined;
  if (root.toLowerCase().includes(query.toLowerCase())) return undefined;
  const parts = root.split("/");
  for (let index = 0; index < parts.length; index++) {
    const suffix = parts.slice(index).join("/");
    if (query.toLowerCase().startsWith(`${suffix.toLowerCase()}/`))
      return query.slice(suffix.length + 1) || undefined;
  }
  return query;
}

export function documentHandlers(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: documentHostContract });
  async function globalProject() {
    return z
      .string()
      .nullable()
      .parse((await bb.storage.kv.get(GLOBAL_KEY)) ?? null);
  }
  async function resolve(source: DocumentSource) {
    if (source.scope === "global" && source.projectId !== (await globalProject()))
      throw new Error("The global source changed. Select it again.");
    const project = await bb.sdk.projects.get({ projectId: source.projectId });
    const registered = project.sources.find((s) => s.id === source.sourceId);
    if (!registered || registered.hostId !== source.hostId || registered.path !== source.rootPath)
      throw new Error("This checkout moved or was removed. Select it again.");
    const machine = await bb.sdk.hosts.get({ hostId: source.hostId });
    if (machine.status !== "connected")
      throw new Error(`${machine.name} is offline. Choose a connected checkout or reconnect it.`);
    return source;
  }
  async function inspect(source: DocumentSource, path: string, readOnlyLinks = false) {
    return host.call(
      "inspectPath",
      { rootPath: source.rootPath, path, readOnlyLinks },
      { hostId: source.hostId, timeoutMs: 15_000 },
    );
  }
  async function fileTarget(file: DocumentFile, readOnlyLinks = false) {
    await resolve(file);
    let boundary = documentBoundary(file.scope, file.path);
    if (boundary === null)
      throw new Error(
        "Choose an instruction, skill, or supporting text file inside an authored directory.",
      );
    const inspected = await inspect(file, file.path, readOnlyLinks);
    const resolvedPath = inspected.resolvedPath ?? file.path;
    boundary = documentBoundary(file.scope, resolvedPath);
    if (boundary === null)
      throw new Error("Linked target is not an authored instruction or skill file.");
    return {
      inspected,
      path: posix.join(inspected.rootPath, resolvedPath),
      rootPath: posix.join(inspected.rootPath, boundary),
    };
  }
  return {
    async documentSources() {
      const [projects, hosts, globalProjectId] = await Promise.all([
        bb.sdk.projects.list(),
        bb.sdk.hosts.list(),
        globalProject(),
      ]);
      return {
        globalProjectId,
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          sources: p.sources.map((s) => {
            const machine = hosts.find((h) => h.id === s.hostId);
            return {
              id: s.id,
              hostId: s.hostId,
              rootPath: s.path,
              hostName: machine?.name ?? s.hostId,
              connected: machine?.status === "connected",
              isDefault: s.isDefault,
            };
          }),
        })),
      };
    },
    async setGlobalProject({ projectId }: { projectId: string }) {
      await bb.sdk.projects.get({ projectId });
      await bb.storage.kv.set(GLOBAL_KEY, projectId);
      return null;
    },
    async documentFiles(source: DocumentSource & { query?: string }) {
      await resolve(source);
      const roots =
        source.scope === "global"
          ? [
              ".dotfiles/.agents/instructions",
              ".dotfiles/.agents/skills",
              ".dotfiles/.agents/plugins",
            ]
          : [".agents/skills", ".bb/skills", ".claude/skills", ".codex/skills"];
      const files = new Set<string>(
        source.scope === "project" ? ["AGENTS.md", "CLAUDE.md", ".bb/AGENTS.md"] : [],
      );
      const warnings: string[] = [];
      let truncated = false;
      // Each root is independent: a missing/unreadable root cannot hide the others.
      await Promise.all(
        roots.map(async (root) => {
          try {
            const inspected = await inspect(source, root);
            if (!inspected.exists) return;
            const listing = await bb.sdk.files.listPaths({
              hostId: source.hostId,
              path: posix.join(inspected.rootPath, root),
              includeFiles: true,
              includeDirectories: false,
              query: relativeDocumentQuery(root, source.query),
              limit: 2000,
              signal: AbortSignal.timeout(15_000),
            });
            truncated ||= listing.truncated;
            for (const entry of listing.paths) {
              const path = `${root}/${entry.path}`;
              if (textExtensions.test(path) && documentBoundary(source.scope, path) !== null)
                files.add(path);
            }
          } catch (error) {
            if (!missing(error))
              warnings.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
      );
      return {
        files: [...files]
          .filter((p) => !source.query || p.toLowerCase().includes(source.query.toLowerCase()))
          .sort(),
        truncated,
        warnings,
      };
    },
    async readDocument(file: DocumentFile) {
      const target = await fileTarget(file, true);
      if (!target.inspected.exists) return { content: "", sha256: null, readOnly: null };
      const read = await bb.sdk.files.read({
        hostId: file.hostId,
        path: target.path,
        rootPath: target.rootPath,
        signal: AbortSignal.timeout(15_000),
      });
      if (read.contentEncoding !== "utf8") throw new Error("This is not a UTF-8 text file.");
      if (read.sizeBytes > MAX_TEXT_BYTES)
        throw new Error("This file is larger than the 1 MiB editor limit.");
      const readOnly = target.inspected.linked
        ? `Linked to ${target.inspected.resolvedPath}. Edit that authored source instead.`
        : managedSkill(file.path)
          ? "Managed by bb. Update with Install CLI skills, not this editor."
          : read.content.trimStart().startsWith("<!-- generated by")
            ? "Generated file. Edit its authored source instead."
            : null;
      return { content: read.content, sha256: read.sha256, readOnly };
    },
    async saveDocument(file: DocumentFile & { content: string; expectedSha256: string | null }) {
      if (managedSkill(file.path)) throw new Error("Managed by bb. This skill is read-only.");
      if (Buffer.byteLength(file.content, "utf8") > MAX_TEXT_BYTES)
        throw new Error("This file is larger than the 1 MiB editor limit.");
      const target = await fileTarget(file);
      if (target.inspected.exists) {
        const current = await bb.sdk.files.read({
          hostId: file.hostId,
          path: target.path,
          rootPath: target.rootPath,
          signal: AbortSignal.timeout(15_000),
        });
        if (
          current.contentEncoding === "utf8" &&
          current.content.trimStart().startsWith("<!-- generated by")
        )
          throw new Error("Generated file. Edit its authored source instead.");
      }
      if (!target.inspected.exists)
        await bb.sdk.files.mkdir({
          hostId: file.hostId,
          path: target.rootPath,
          rootPath: target.inspected.rootPath,
          recursive: true,
        });
      await resolve(file);
      const result = await bb.sdk.files.write({
        hostId: file.hostId,
        path: target.path,
        rootPath: target.rootPath,
        content: file.content,
        expectedSha256: file.expectedSha256,
        createParents: true,
      });
      return result.outcome === "written"
        ? { outcome: "written" as const, sha256: result.sha256 }
        : { outcome: "conflict" as const };
    },
    async applyDocuments(source: DocumentSource & { task: "render" | "install:agent-plugins" }) {
      if (source.scope !== "global")
        throw new Error("Only global sources need a Dotfiles apply step.");
      await resolve(source);
      const inspected = await inspect(source, ".");
      return bb.sdk.plugins.callRpc({
        pluginId: "dotfiles",
        method: "runTask",
        input: { hostId: source.hostId, task: source.task, expectedRepoPath: inspected.rootPath },
        outputSchema: z.object({ exitCode: z.number().int(), output: z.string() }),
      });
    },
  };
}
