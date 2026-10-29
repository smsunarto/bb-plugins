import { relativeDocumentQuery } from "./server.ts";
import { afterEach, expect, test } from "bun:test";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import plugin from "../server/server.ts";
import hostEntry from "./host.ts";
import { documentHostContract, documentBoundary } from "./model.ts";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "instruction-files-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const machine = experimental_createHostEntryHarness(hostEntry);
  cleanup.push(() => machine.experimental_dispose());
  let sourcePath = root;
  let connected = true;
  const writes: unknown[] = [];
  const project = () => ({
    id: "project",
    name: "Project",
    kind: "standard" as const,
    gitRemoteUrl: null,
    createdAt: 1,
    updatedAt: 1,
    sources: [
      {
        id: "source",
        projectId: "project",
        type: "local_path" as const,
        hostId: "host",
        path: sourcePath,
        isDefault: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  });
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-instructions",
    experimental_callHostRpc: (call) =>
      machine.experimental_call(
        "inspectPath",
        documentHostContract.inspectPath.input.parse(call.input),
      ),
    sdk: {
      projects: { list: async () => [project()], get: async () => project() },
      hosts: {
        list: async () => [makeHostResponse({ id: "host" })],
        get: async () => ({
          ...makeHostResponse({ id: "host", status: connected ? "connected" : "disconnected" }),
          connectMachineId: null,
          threadStorageRootPath: null,
        }),
      },
      files: {
        read: async ({ path }) => {
          const content = await readFile(path, "utf8");
          return {
            path,
            content,
            contentEncoding: "utf8",
            sha256: hash(content),
            sizeBytes: Buffer.byteLength(content),
          };
        },
        mkdir: async ({ path }) => {
          await mkdir(path, { recursive: true });
          return { path };
        },
        write: async (args) => {
          writes.push(args);
          let current: string | null = null;
          try {
            current = hash(await readFile(args.path, "utf8"));
          } catch {
            /* Missing is create-only. */
          }
          if (current !== args.expectedSha256)
            return { outcome: "conflict", currentSha256: current };
          if (args.createParents) await mkdir(dirname(args.path), { recursive: true });
          await writeFile(args.path, args.content);
          return {
            outcome: "written",
            sha256: hash(args.content),
            sizeBytes: Buffer.byteLength(args.content),
          };
        },
        listPaths: async () => ({
          paths: [
            { path: "example/SKILL.md", kind: "file", name: "SKILL.md", score: 0, positions: [] },
            {
              path: "example/references/guide.md",
              kind: "file",
              name: "guide.md",
              score: 0,
              positions: [],
            },
            {
              path: "example/references/settings.json",
              kind: "file",
              name: "settings.json",
              score: 0,
              positions: [],
            },
          ],
          truncated: true,
        }),
      },
    },
  });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const source = {
    scope: "project" as const,
    projectId: "project",
    sourceId: "source",
    hostId: "host",
    rootPath: root,
  };
  async function put(path: string, content: string) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return {
    root,
    harness,
    put,
    source,
    writes,
    call: harness.behavior.callRpc.bind(harness.behavior),
    relocate: () => {
      sourcePath += "-moved";
    },
    offline: () => {
      connected = false;
    },
  };
}
test("edits project instructions with CAS and refuses a changed file", async () => {
  const f = await setup();
  await f.put("AGENTS.md", "original");
  const file = { ...f.source, path: "AGENTS.md" };
  expect(await f.call("readDocument", file)).toMatchObject({
    content: "original",
    sha256: hash("original"),
  });
  await f.put("AGENTS.md", "external");
  expect(
    await f.call("saveDocument", { ...file, content: "mine", expectedSha256: hash("original") }),
  ).toEqual({ outcome: "conflict" });
  expect(await readFile(join(f.root, "AGENTS.md"), "utf8")).toBe("external");
});
test("creates a skill reference without replacing an existing file", async () => {
  const f = await setup();
  const path = ".agents/skills/example/references/data.json";
  expect(await f.call("readDocument", { ...f.source, path })).toMatchObject({ sha256: null });
  expect(
    await f.call("saveDocument", { ...f.source, path, content: "{}", expectedSha256: null }),
  ).toMatchObject({ outcome: "written" });
  expect(await readFile(join(f.root, path), "utf8")).toBe("{}");
  expect(
    await f.call("saveDocument", { ...f.source, path, content: "changed", expectedSha256: null }),
  ).toEqual({ outcome: "conflict" });
});
test("rejects paths outside authored roots and symlinks inside the checkout", async () => {
  const f = await setup();
  expect(documentBoundary("project", ".agents/skills/x/../../secret.md")).toBeNull();
  await expect(f.call("readDocument", { ...f.source, path: "package.json" })).rejects.toThrow(
    "authored directory",
  );
  await f.put("private.md", "secret");
  await symlink(join(f.root, "private.md"), join(f.root, "AGENTS.md"));
  await expect(
    f.call("saveDocument", {
      ...f.source,
      path: "AGENTS.md",
      content: "bad",
      expectedSha256: hash("secret"),
    }),
  ).rejects.toThrow("Linked files");
  expect(f.writes).toHaveLength(0);
});
test("rejects stale or offline source identities before file IO", async () => {
  const f = await setup();
  f.relocate();
  await expect(f.call("readDocument", { ...f.source, path: "AGENTS.md" })).rejects.toThrow(
    "moved or was removed",
  );
  const other = await setup();
  other.offline();
  await expect(other.call("readDocument", { ...other.source, path: "AGENTS.md" })).rejects.toThrow(
    "offline",
  );
});
test("lists reference files and exposes incomplete results", async () => {
  const f = await setup();
  await f.put(".agents/skills/example/SKILL.md", "skill");
  expect(await f.call("documentFiles", f.source)).toMatchObject({
    truncated: true,
    files: expect.arrayContaining([
      ".agents/skills/example/SKILL.md",
      ".agents/skills/example/references/guide.md",
      ".agents/skills/example/references/settings.json",
    ]),
  });
});
test("global source selection is persisted and generated files cannot be overwritten", async () => {
  const f = await setup();
  await f.call("setGlobalProject", { projectId: "project" });
  expect(await f.call("documentSources", null)).toMatchObject({ globalProjectId: "project" });
  await f.put("AGENTS.md", "<!-- generated by renderer -->\noriginal");
  await expect(
    f.call("saveDocument", {
      ...f.source,
      path: "AGENTS.md",
      content: "bad",
      expectedSha256: hash("<!-- generated by renderer -->\noriginal"),
    }),
  ).rejects.toThrow("Generated file");
});

test("bb-owned skills are read-only", async () => {
  const f = await setup();
  await f.call("setGlobalProject", { projectId: "project" });
  const file = { ...f.source, scope: "global", path: ".dotfiles/.agents/skills/bb-cli/SKILL.md" };
  await f.put(file.path, "managed");
  expect(await f.call("readDocument", file)).toMatchObject({
    readOnly: expect.stringContaining("Managed by bb"),
  });
  await expect(
    f.call("saveDocument", { ...file, content: "bad", expectedSha256: hash("managed") }),
  ).rejects.toThrow("read-only");
});

test("global apply passes its canonical source to the guarded executor", async () => {
  const f = await setup();
  await f.call("setGlobalProject", { projectId: "project" });
  const tasks: unknown[] = [];
  f.harness.sdk.stub("plugins.callRpc", async (args: { method: string; input: unknown }) => {
    tasks.push(args);
    return { exitCode: 0, output: "rendered" };
  });
  expect(await f.call("applyDocuments", { ...f.source, scope: "global", task: "render" })).toEqual({
    exitCode: 0,
    output: "rendered",
  });
  expect(tasks).toMatchObject([
    { method: "runTask", input: { hostId: "host", task: "render", expectedRepoPath: f.root } },
  ]);
});

test("instruction aliases can be read but must be edited at their authored target", async () => {
  const f = await setup();
  await f.put("AGENTS.md", "authored");
  await symlink("AGENTS.md", join(f.root, "CLAUDE.md"));
  expect(await f.call("readDocument", { ...f.source, path: "CLAUDE.md" })).toMatchObject({
    content: "authored",
    readOnly: expect.stringContaining("AGENTS.md"),
  });
  await expect(
    f.call("saveDocument", {
      ...f.source,
      path: "CLAUDE.md",
      content: "bad",
      expectedSha256: hash("authored"),
    }),
  ).rejects.toThrow("Linked files");
});

test("full-path searches translate to each listing root", () => {
  expect(relativeDocumentQuery(".agents/skills", ".agents")).toBeUndefined();
  expect(relativeDocumentQuery(".dotfiles/.agents/plugins", "plugins/scott")).toBe("scott");
  expect(relativeDocumentQuery(".agents/skills", "references/checklist")).toBe(
    "references/checklist",
  );
});
