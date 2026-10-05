import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { API_PREFIX } from "../../shared/contracts/api-tunnel.ts";
import { createEngine } from "../../server/lib/engine.ts";
import { gitFixture } from "../../server/lib/host-io/testing/git-fixture.ts";
import {
  createInProcessHostClient,
  IN_PROCESS_HOST_ID,
} from "../../server/lib/host-io/testing/in-process.ts";
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
  const request = async (path: string, body?: unknown) => {
    const result = await engine.request({
      method: body === undefined ? "GET" : "POST",
      path,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: result.status, body: JSON.parse(result.body) };
  };
  const reader = createSourceReader(async (url) => {
    const parsed = new URL(url);
    const result = await engine.request({
      method: "GET",
      path: `${parsed.pathname.slice(API_PREFIX.length)}${parsed.search}`,
    });
    return new Response(result.body, { status: result.status });
  });
  return {
    repo,
    request,
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
  const { repo, request, reader } = fixture;
  try {
    const registered = await request("/repositories", { path: repo.root });
    expect(registered.status).toBe(200);
    repo.write("src/a.ts", "export const state = 'queued';\n");
    const created = await request("/commands", {
      commandId: randomUUID(),
      operation: {
        type: "create",
        title: "Dirty source",
        target: { kind: "worktree", repositoryId: registered.body.id },
      },
    });
    expect(created.status).toBe(200);
    const reviewId: string = created.body.reviewId;
    const first = (await request(`/${reviewId}?full=true`)).body;
    expect(first.version).toBe(0);
    expect(
      await reader.file(
        { reviewId, version: 0, generation: first.pins.worktreeRevision },
        "head",
        "src/a.ts",
      ),
    ).toMatchObject({ text: "export const state = 'queued';\n" });
    repo.write("src/a.ts", "export const state = 'processing';\nexport const count = 2;\n");
    let next = first;
    await vi.waitFor(
      async () => {
        next = (await request(`/${reviewId}?full=true`)).body;
        expect(next.pins.worktreeRevision).not.toBe(first.pins.worktreeRevision);
      },
      { timeout: 5_000 },
    );
    expect(next.version).toBe(0);
    const current = { reviewId, version: 0, generation: next.pins.worktreeRevision };
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
    const { repo, request, reader } = fixture;
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
      const registered = await request("/repositories", { path: repo.root });
      expect(registered.status).toBe(200);
      const created = await request("/commands", {
        commandId: randomUUID(),
        operation: {
          type: "create",
          title: "Filtered dirty source",
          target: { kind: "worktree", repositoryId: registered.body.id },
        },
      });
      expect(created.status).toBe(200);
      const reviewId: string = created.body.reviewId;
      const snapshot = (await request(`/${reviewId}?full=true`)).body;
      const current = {
        reviewId,
        version: snapshot.version,
        generation: snapshot.pins.worktreeRevision,
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
