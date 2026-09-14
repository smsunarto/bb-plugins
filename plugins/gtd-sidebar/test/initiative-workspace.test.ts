import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { inspectSharedDirectory } from "../lib/shared-directory-host.ts";
import { createInitiativeWorkspaceResolver } from "../lib/initiative-workspace.ts";

const withDirectories = async (
  run: (fixture: { root: string; repoA: string; nested: string; repoB: string }) => Promise<void>,
) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gtd-shared-workspace-")));
  const repoA = join(root, "repo-a");
  const nested = join(repoA, "nested-repo");
  const repoB = join(root, "repo-b");
  mkdirSync(nested, { recursive: true });
  mkdirSync(repoB, { recursive: true });
  try {
    await run({ root, repoA, nested, repoB });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const resolverForPaths = (paths: readonly [string, string]) =>
  createInitiativeWorkspaceResolver({
    projects: {
      async get({ projectId }) {
        const index = projectId === "proj_a" ? 0 : 1;
        return {
          id: projectId,
          name: projectId,
          sources: [{ hostId: "host_a", path: paths[index], isDefault: true }],
        } as never;
      },
    },
    hosts: {
      async get() {
        return { id: "host_a", name: "Machine A", status: "connected" } as never;
      },
    },
    inspectSharedDirectory: (_hostId, input) => inspectSharedDirectory(input),
  });

describe("shared directory host validation", () => {
  it("canonicalizes paths and permits nested repository roots", async () => {
    await withDirectories(async ({ repoA, nested }) => {
      const inspected = await inspectSharedDirectory({ repositoryPaths: [repoA, nested] });
      assert.equal(inspected.suggestedRootPath, repoA);
      assert.deepEqual(inspected.rootContainsRepositories, [true, true]);
      assert.ok(inspected.repositories.every((entry) => entry.kind === "directory"));
    });
  });

  it("rejects relative roots on the selected host instead of resolving daemon cwd", async () => {
    await withDirectories(async ({ repoA, repoB }) => {
      const inspected = await inspectSharedDirectory({
        repositoryPaths: [repoA, repoB],
        rootPath: "relative/root",
      });
      assert.equal(inspected.root?.kind, "error");
      assert.equal(inspected.root?.message, "path must be absolute");
      assert.deepEqual(inspected.rootContainsRepositories, [true, true]);
    });
  });
});

describe("shared directory preview", () => {
  it("accepts a validated broader parent and returns canonical repository snapshots", async () => {
    await withDirectories(async ({ root, repoA, nested }) => {
      const resolve = createInitiativeWorkspaceResolver({
        projects: {
          async get({ projectId }) {
            const path = projectId === "proj_a" ? repoA : nested;
            return {
              id: projectId,
              name: projectId,
              sources: [{ hostId: "host_a", path, isDefault: true }],
            } as never;
          },
        },
        hosts: {
          async get() {
            return { id: "host_a", name: "Machine A", status: "connected" } as never;
          },
        },
        inspectSharedDirectory: (_hostId, input) => inspectSharedDirectory(input),
      });

      const preview = await resolve({
        workspaceProjectIds: ["proj_a", "proj_nested"],
        candidate: { hostId: "host_a", rootPath: root },
      });
      assert.equal(preview.eligible, true);
      assert.equal(preview.suggested?.rootPath, repoA);
      assert.equal(preview.selection?.rootPath, root);
      assert.deepEqual(
        preview.repositories.map((repository) => repository.path),
        [repoA, nested],
      );
    });
  });

  it("returns before filesystem inspection for cross-host selections", async () => {
    let inspections = 0;
    const resolve = createInitiativeWorkspaceResolver({
      projects: {
        async get({ projectId }: { projectId: string }) {
          return {
            id: projectId,
            name: projectId,
            sources: [
              {
                hostId: projectId === "proj_a" ? "host_a" : "host_b",
                path: `/repos/${projectId}`,
                isDefault: true,
              },
            ],
          } as never;
        },
      },
      hosts: {
        async get() {
          throw new Error("must not inspect a host");
        },
      },
      async inspectSharedDirectory() {
        inspections++;
        throw new Error("must not inspect paths");
      },
    } as never);
    const preview = await resolve({ workspaceProjectIds: ["proj_a", "proj_b"] });
    assert.equal(preview.eligible, false);
    assert.equal(
      preview.errors.some((entry) => entry.code === "cross-host"),
      true,
    );
    assert.equal(inspections, 0);
  });

  it("reports the 32-repository boundary without mislabeling it as a host failure", async () => {
    let projectReads = 0;
    const resolve = createInitiativeWorkspaceResolver({
      projects: {
        async get() {
          projectReads++;
          throw new Error("must not load");
        },
      },
      hosts: {
        async get() {
          throw new Error("must not load");
        },
      },
      async inspectSharedDirectory() {
        throw new Error("must not inspect");
      },
    } as never);
    const preview = await resolve({
      workspaceProjectIds: Array.from({ length: 33 }, (_, index) => `proj_${index}`),
    });
    assert.deepEqual(
      preview.errors.map((entry) => entry.code),
      ["too-many-repositories"],
    );
    assert.equal(projectReads, 0);
  });

  it("rejects filesystem root and home as unsafe shared directories", async () => {
    await withDirectories(async ({ repoA, repoB }) => {
      const resolve = resolverForPaths([repoA, repoB]);
      for (const rootPath of ["/", homedir()]) {
        const preview = await resolve({
          workspaceProjectIds: ["proj_a", "proj_b"],
          candidate: { rootPath },
        });
        assert.equal(preview.eligible, false);
        assert.equal(
          preview.errors.some((entry) => entry.code === "unsafe-root"),
          true,
        );
      }
    });
  });

  it("distinguishes missing roots, files, and repositories outside the root", async () => {
    await withDirectories(async ({ root, repoA, repoB }) => {
      const resolve = resolverForPaths([repoA, repoB]);
      const missing = await resolve({
        workspaceProjectIds: ["proj_a", "proj_b"],
        candidate: { rootPath: join(root, "missing") },
      });
      assert.equal(
        missing.errors.some((entry) => entry.code === "root-missing"),
        true,
      );

      const file = join(root, "ordinary-file");
      writeFileSync(file, "not a directory");
      const notDirectory = await resolve({
        workspaceProjectIds: ["proj_a", "proj_b"],
        candidate: { rootPath: file },
      });
      assert.equal(
        notDirectory.errors.some((entry) => entry.code === "root-not-directory"),
        true,
      );

      const outside = await resolve({
        workspaceProjectIds: ["proj_a", "proj_b"],
        candidate: { rootPath: repoA },
      });
      assert.equal(
        outside.errors.some((entry) => entry.code === "outside-root"),
        true,
      );
    });
  });

  it("rejects duplicate canonical checkout paths", async () => {
    await withDirectories(async ({ root, repoA }) => {
      const resolve = resolverForPaths([repoA, repoA]);
      const preview = await resolve({
        workspaceProjectIds: ["proj_a", "proj_b"],
        candidate: { rootPath: root },
      });
      assert.equal(preview.eligible, false);
      assert.equal(
        preview.errors.some((entry) => entry.code === "duplicate-path"),
        true,
      );
    });
  });
});
