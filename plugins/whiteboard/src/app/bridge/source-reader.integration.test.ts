import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createEngine } from "../../server/lib/engine.ts";
import { gitFixture } from "../../server/lib/host-io/testing/git-fixture.ts";
import {
  createInProcessHostClient,
  IN_PROCESS_HOST_ID,
} from "../../server/lib/host-io/testing/in-process.ts";
import { registerRpc } from "../../server/rpc/contract.ts";
import { type Output, wire } from "../rpc.ts";
import { createSourceReader, loadFileModel } from "./diff-view.tsx";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  experimental_Diff: () => null,
  experimental_SourceCode: () => null,
}));

function setup() {
  const repo = gitFixture("whiteboard-source-reader-");
  const host = createFakePluginHost({ pluginId: "whiteboard" });
  const client = createInProcessHostClient();
  const bb = {
    ...host.bb,
    hosts: { ...host.bb.hosts, experimental_client: () => client },
    sdk: {
      ...host.bb.sdk,
      hosts: {
        ...host.bb.sdk.hosts,
        list: async () => [
          { id: IN_PROCESS_HOST_ID, name: "Test host", type: "persistent", status: "connected" },
        ],
      },
    },
  } as unknown as BbPluginApi;
  const engine = createEngine(bb, {
    scratchpadEnabled: () => false,
    softwareMapEnabled: () => false,
    subscribe: () => () => {},
  });
  registerRpc({ bb, engine });
  // The panel's calls, through the registered methods' input schemas.
  const call = <T>(method: string, input: unknown) =>
    host.harness.behavior.callRpc(method, wire(input)) as Promise<T>;
  const register = async () =>
    (await engine.run({}, () => engine.api.registerRepository({ path: repo.root }))).id;
  const create = async (repositoryId: string, title: string) =>
    (
      await call<{ reviewId: string }>("command", {
        commandId: randomUUID(),
        operation: {
          type: "create",
          source: "target",
          title,
          target: { kind: "worktree", repositoryId },
        },
      })
    ).reviewId;
  const current = (sessionId: string) => call<Output<"liveSession">>("liveSession", { sessionId });
  const reader = createSourceReader({
    diffFiles: (input) => call("diffFiles", input),
    file: (input) => call("file", input),
  });
  return {
    repo,
    register,
    create,
    current,
    reader,
    async dispose() {
      await engine.dispose();
      await client.simulateWorkerExit();
      await host.harness.dispose();
      repo.remove();
    },
  };
}

it("refreshes dirty worktree source at the same authored version and retains historical source", async () => {
  const fixture = setup();
  const { repo, register, create, current: read, reader } = fixture;
  try {
    const repositoryId = await register();
    repo.write("src/a.ts", "export const state = 'queued';\n");
    const reviewId = await create(repositoryId, "Dirty source");
    const first = await read(reviewId);
    expect(first.version).toBe(0);
    expect(
      await reader.file(
        { reviewId, version: 0, generation: first.source!.pins.worktreeRevision },
        "head",
        "src/a.ts",
      ),
    ).toMatchObject({ text: "export const state = 'queued';\n" });
    repo.write("src/a.ts", "export const state = 'processing';\nexport const count = 2;\n");
    let next = first;
    await vi.waitFor(
      async () => {
        next = await read(reviewId);
        expect(next.source!.pins.worktreeRevision).not.toBe(first.source!.pins.worktreeRevision);
      },
      { timeout: 5_000 },
    );
    expect(next.version).toBe(0);
    const current = { reviewId, version: 0, generation: next.source!.pins.worktreeRevision };
    expect(await reader.file(current, "head", "src/a.ts")).toMatchObject({
      text: "export const state = 'processing';\nexport const count = 2;\n",
      localPath: `${repo.root}/src/a.ts`,
    });
    expect(await reader.files(current)).toEqual([
      { path: "src/a.ts", status: "modified", additions: 2, deletions: 2 },
    ]);
    const retained = await reader.file({ reviewId, version: 0 }, "head", "src/a.ts");
    expect(retained).toMatchObject({
      text: "export const state = 'queued';\n",
    });
    expect(retained).not.toHaveProperty("localPath");
    expect(await reader.files({ reviewId, version: 0 })).toEqual([
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 2 },
    ]);
  } finally {
    await fixture.dispose();
  }
});

it.each(["clean filter", "CRLF"])(
  "uses Git's %s projection for native Diff and preserves exact raw source",
  async (kind) => {
    const fixture = setup();
    const { repo, register, create, current: read, reader } = fixture;
    try {
      if (kind === "clean filter") {
        repo.git("config", "filter.upper.clean", "tr '[:lower:]' '[:upper:]'");
        repo.write(".gitattributes", "src/a.ts filter=upper\n");
      } else {
        repo.git("config", "core.autocrlf", "true");
        repo.write(".gitattributes", "* text=auto\n");
      }
      repo.git("add", "--renormalize", ".");
      repo.commit("Canonical attributes");
      const raw =
        kind === "CRLF"
          ? "export const a = 11;\r\nexport const a2 = 20;\r\n"
          : "export const a = 11;\nexport const a2 = 20;\n";
      const canonical =
        kind === "clean filter"
          ? "EXPORT CONST A = 11;\nEXPORT CONST A2 = 20;\n"
          : "export const a = 11;\nexport const a2 = 20;\n";
      repo.write("src/a.ts", raw);
      expect(repo.git("diff", "--numstat", "HEAD")).toBe("1\t1\tsrc/a.ts\n");
      const reviewId = await create(await register(), "Filtered dirty source");
      const snapshot = await read(reviewId);
      const current = {
        reviewId,
        version: snapshot.version,
        generation: snapshot.source!.pins.worktreeRevision,
      };
      const files = await reader.files(current);
      expect(files).toEqual([{ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }]);
      const model = await loadFileModel(reader, current, files[0]!);
      expect(model.new.content).toBe(canonical);
      expect(model.patch!.split("\n").filter((line) => /^[+-](?![+-])/.test(line))).toEqual(
        kind === "clean filter"
          ? ["-EXPORT CONST A = 10;", "+EXPORT CONST A = 11;"]
          : ["-export const a = 10;", "+export const a = 11;"],
      );
      expect(model.firstChangedLine).toBe(1);
      expect(model.livePath).toBeUndefined();
      expect(await reader.file(current, "head", "src/a.ts")).toMatchObject({
        text: raw,
        localPath: `${repo.root}/src/a.ts`,
      });
      expect(
        (await reader.file({ reviewId, version: 0 }, "head", "src/a.ts", "comparison")).text,
      ).toBe(canonical);
      expect((await reader.file({ reviewId, version: 0 }, "head", "src/a.ts")).text).toBe(raw);
    } finally {
      await fixture.dispose();
    }
  },
);
