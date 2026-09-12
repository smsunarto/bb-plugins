import { describe, expect, mock, test } from "bun:test";
import { stubHostContext } from "@bb-kit/core/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { codeCitation } from "../lib/code-citation.ts";
import { renderEmbed } from "./render-embed.ts";
import { renderEmbedInputSchema } from "../../shared/contract.ts";
function context(content = "one\ntwo\nthree\n") {
  const read = mock(async () => ({ contentEncoding: "utf8", content }));
  const bb = {
    sdk: {
      threads: {
        get: async () => ({ environmentId: "e", projectId: "proj_own" }),
        list: async () => [],
      },
      environments: { get: async () => ({ hostId: "h", path: "/workspace" }) },
      files: { read },
      projects: { list: async () => [] },
      hosts: { pathsExist: async () => ({ existence: {} }) },
    },
    log: { warn() {}, debug() {} },
  } as unknown as BbPluginApi;
  return { ctx: stubHostContext({ bb }), read, bb };
}
describe("codeCitation", () => {
  test("keeps the source line numbers and adds bounded context", () => {
    const result = codeCitation("src/example.ts", "one\ntwo\nthree\nfour\nfive\n", 3, 4);
    expect(result).toEqual({
      label: "src/example.ts:L3-L4",
      content: "one\ntwo\nthree\nfour\nfive",
      startLine: 1,
    });
  });

  test("rejects reversed and oversized ranges", () => {
    expect(codeCitation("x.ts", "one\ntwo", 2, 1)).toEqual({
      error: "The citation end line must not come before its start line.",
    });
    expect(codeCitation("x.ts", `${"line\n".repeat(205)}`, 1, 201)).toEqual({
      error: "A code citation can include at most 200 lines.",
    });
  });
});

test("reads citations through their environment host and root fence", async () => {
  const { ctx, read } = context();
  expect(
    await renderEmbed.execute(ctx, { kind: "code", threadId: "t", path: "src/a.ts", start: 2 }),
  ).toMatchObject({ status: "ready", content: "one\ntwo\nthree", startLine: 1 });
  expect(read).toHaveBeenCalledWith({
    hostId: "h",
    path: "/workspace/src/a.ts",
    rootPath: "/workspace",
  });
});
test("rejects escaping paths and incomplete diff/patch requests", async () => {
  for (const path of ["../secret", "/etc/passwd", "a/../secret", "a\\secret"]) {
    const { ctx, read } = context();
    expect(await renderEmbed.execute(ctx, { kind: "code", threadId: "t", path })).toMatchObject({
      status: "error",
    });
    expect(read).not.toHaveBeenCalled();
  }
  for (const kind of ["diff", "patch"])
    expect(renderEmbedInputSchema.safeParse({ kind, threadId: "t", path: "a" }).success).toBe(
      false,
    );
});
test("Unity citations show current values and malformed YAML falls back to source", async () => {
  const { ctx } = context("--- !u!1 &1\nGameObject:\n  m_Name: Player\n  m_IsActive: 1\n");
  const result = await renderEmbed.execute(ctx, {
    kind: "code",
    threadId: "t",
    path: "Player.prefab",
  });
  expect(result).toMatchObject({
    status: "ready",
    kind: "code",
    unity: {
      propertyCount: 2,
      groups: [
        {
          name: "Player",
          components: [
            {
              properties: [
                { path: "m_Name", value: '"Player"' },
                { path: "m_IsActive", value: "1" },
              ],
            },
          ],
        },
      ],
    },
  });
  const malformed = context("--- !u!1 &1\nGameObject: [broken");
  expect(
    await renderEmbed.execute(malformed.ctx, { kind: "code", threadId: "t", path: "World.unity" }),
  ).toMatchObject({ status: "ready", unityNotice: expect.any(String) });
});

describe("cross-workspace citations", () => {
  const source = (hostId: string, path: string) => ({
    hostId,
    path,
    isDefault: true,
    id: "s",
    type: "local_path" as const,
    projectId: "p",
    createdAt: 0,
    updatedAt: 0,
  });
  const project = (id: string, name: string, path: string, hostId = "h") => ({
    id,
    name,
    kind: "standard" as const,
    gitRemoteUrl: null,
    sources: [source(hostId, path)],
    createdAt: 0,
    updatedAt: 0,
  });

  test("workspace= reads the file from the named project checkout", async () => {
    const { ctx, read, bb } = context();
    bb.sdk.projects.list = async () => [project("proj_bb", "bb-plugins", "/bb-plugins")];
    const result = await renderEmbed.execute(ctx, {
      kind: "code",
      threadId: "t",
      path: "src/a.ts",
      workspace: "bb-plugins",
    });
    expect(result).toMatchObject({
      status: "ready",
      workspace: "bb-plugins",
      content: "one\ntwo\nthree",
    });
    expect(read).toHaveBeenCalledWith({
      hostId: "h",
      path: "/bb-plugins/src/a.ts",
      rootPath: "/bb-plugins",
    });
  });

  test("workspace= resolves an environment id directly", async () => {
    const { ctx, read, bb } = context();
    bb.sdk.environments.get = (async ({ environmentId }: { environmentId: string }) => ({
      hostId: "h",
      path: environmentId === "env_other" ? "/other" : "/workspace",
    })) as never;
    const result = await renderEmbed.execute(ctx, {
      kind: "code",
      threadId: "t",
      path: "src/a.ts",
      workspace: "env_other",
    });
    expect(result).toMatchObject({ status: "ready", workspace: "other" });
    expect(read).toHaveBeenCalledWith({
      hostId: "h",
      path: "/other/src/a.ts",
      rootPath: "/other",
    });
  });

  test("an unknown workspace selector is an explicit error", async () => {
    const { ctx, read } = context();
    expect(
      await renderEmbed.execute(ctx, {
        kind: "code",
        threadId: "t",
        path: "src/a.ts",
        workspace: "nope",
      }),
    ).toMatchObject({
      status: "error",
      message: expect.stringContaining('Unknown workspace "nope"'),
    });
    expect(read).not.toHaveBeenCalled();
  });

  test("a citation missing from the thread workspace falls back to a unique foreign hit", async () => {
    const { ctx, read, bb } = context();
    read.mockRejectedValueOnce(Object.assign(new Error("HTTP 404"), { status: 404 }));
    bb.sdk.projects.list = async () => [
      project("proj_own", "dotfiles", "/dotfiles"),
      project("proj_bb", "bb-plugins", "/bb-plugins"),
    ];
    bb.sdk.hosts.pathsExist = (async ({ paths }: { paths: string[] }) => ({
      existence: Object.fromEntries(
        paths.map((path: string) => [path, path.startsWith("/bb-plugins")]),
      ),
    })) as never;
    const result = await renderEmbed.execute(ctx, {
      kind: "code",
      threadId: "t",
      path: "src/a.ts",
    });
    expect(result).toMatchObject({ status: "ready", workspace: "bb-plugins" });
    expect(read).toHaveBeenLastCalledWith({
      hostId: "h",
      path: "/bb-plugins/src/a.ts",
      rootPath: "/bb-plugins",
    });
  });

  test("the containing thread's project wins over other matching workspaces", async () => {
    const { ctx, read, bb } = context();
    read.mockRejectedValueOnce(Object.assign(new Error("HTTP 404"), { status: 404 }));
    bb.sdk.projects.list = async () => [
      project("proj_own", "dotfiles", "/dotfiles-main"),
      project("proj_bb", "bb-plugins", "/bb-plugins"),
    ];
    bb.sdk.hosts.pathsExist = (async ({ paths }: { paths: string[] }) => ({
      existence: Object.fromEntries(paths.map((path: string) => [path, true])),
    })) as never;
    const result = await renderEmbed.execute(ctx, {
      kind: "code",
      threadId: "t",
      path: "src/a.ts",
    });
    expect(result).toMatchObject({ status: "ready", workspace: "dotfiles" });
    expect(read).toHaveBeenLastCalledWith({
      hostId: "h",
      path: "/dotfiles-main/src/a.ts",
      rootPath: "/dotfiles-main",
    });
  });

  test("several foreign hits fail closed with the candidate names", async () => {
    const { ctx, read, bb } = context();
    read.mockRejectedValueOnce(Object.assign(new Error("HTTP 404"), { status: 404 }));
    bb.sdk.projects.list = async () => [
      project("proj_bb", "bb-plugins", "/bb-plugins"),
      project("proj_bb2", "bb", "/bb"),
    ];
    bb.sdk.hosts.pathsExist = (async ({ paths }: { paths: string[] }) => ({
      existence: Object.fromEntries(paths.map((path: string) => [path, true])),
    })) as never;
    const result = await renderEmbed.execute(ctx, {
      kind: "code",
      threadId: "t",
      path: "src/a.ts",
    });
    if (result.status !== "error") throw new Error("expected an error");
    expect(result.message).toContain("bb-plugins");
    expect(result.message).toContain("bb");
    expect(result.message).toContain("workspace=");
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("a citation missing everywhere keeps the original error", async () => {
    const { ctx, read } = context();
    read.mockRejectedValueOnce(Object.assign(new Error("HTTP 404"), { status: 404 }));
    expect(
      await renderEmbed.execute(ctx, { kind: "code", threadId: "t", path: "src/a.ts" }),
    ).toMatchObject({
      status: "error",
      message: "Could not load src/a.ts from any known workspace.",
    });
  });

  test("non-miss read failures never probe other workspaces", async () => {
    const { ctx, read, bb } = context();
    read.mockRejectedValueOnce(new Error("permission denied"));
    bb.sdk.hosts.pathsExist = mock(async () => ({ existence: {} })) as never;
    expect(
      await renderEmbed.execute(ctx, { kind: "code", threadId: "t", path: "src/a.ts" }),
    ).toMatchObject({
      status: "error",
      message: "Could not load src/a.ts from this workspace.",
    });
    expect(bb.sdk.hosts.pathsExist).not.toHaveBeenCalled();
  });
});
