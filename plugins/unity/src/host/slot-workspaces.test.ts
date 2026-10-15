import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertWorkspaceStopped,
  inspectRampageWorkspace,
  resolveWorkspacePath,
  planSlotDestination,
} from "./slot-workspaces.ts";

const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "bb-rampage-slot-")));
  paths.push(path);
  await Promise.all(
    [".git", "Assets/Rampage/Editor", "Packages", "ProjectSettings"].map((directory) =>
      mkdir(join(path, directory), { recursive: true }),
    ),
  );
  await Promise.all([
    writeFile(join(path, "package.json"), JSON.stringify({ name: "rampage-client" })),
    writeFile(
      join(path, "Assets/Rampage/Editor/ArgusLabs.Rampage.Editor.asmdef"),
      JSON.stringify({ name: "ArgusLabs.Rampage.Editor" }),
    ),
    writeFile(
      join(path, "Packages/manifest.json"),
      JSON.stringify({ dependencies: { "com.unity.test-framework": "1.4.6" } }),
    ),
    writeFile(
      join(path, "ProjectSettings/ProjectVersion.txt"),
      "m_EditorVersion: 6000.3.10f1\nm_EditorVersionWithRevision: 6000.3.10f1 (e35f0c77bd8e)\n",
    ),
  ]);
  return path;
}

const stopped = { listEditors: async () => [] };

test("creation planning canonicalizes the parent and never overwrites existing paths", async () => {
  const parent = await fixture();
  const alias = `${parent}-parent-alias`;
  paths.push(alias);
  await symlink(parent, alias);
  expect(await planSlotDestination(join(alias, "new-slot"))).toEqual({
    workspacePath: join(parent, "new-slot"),
  });
  await expect(planSlotDestination("relative/new-slot")).rejects.toThrow("absolute");
  await expect(planSlotDestination(parent)).rejects.toThrow("already exists");
  await expect(planSlotDestination(alias)).rejects.toThrow("already exists");
  expect(JSON.parse(await readFile(join(parent, "package.json"), "utf8")).name).toBe(
    "rampage-client",
  );
});

test("workspace resolution maps directory aliases and an MPPM clone's shared Assets to the main checkout", async () => {
  const main = await fixture();
  const alias = `${main}-alias`;
  paths.push(alias);
  await symlink(main, alias);
  const clone = await fixture();
  await rm(join(clone, "Assets"), { recursive: true });
  await symlink(join(main, "Assets"), join(clone, "Assets"));
  expect(await resolveWorkspacePath(alias)).toEqual({ workspacePath: main });
  expect(await resolveWorkspacePath(clone)).toEqual({ workspacePath: main });
  expect(await resolveWorkspacePath(join(main, "missing"))).toEqual({ workspacePath: null });
});

test("adoption canonicalizes an independent Rampage checkout without requiring Unity caches", async () => {
  const path = await fixture();
  const alias = `${path}-alias`;
  paths.push(alias);
  await symlink(path, alias);
  expect(await inspectRampageWorkspace(alias)).toEqual({
    workspacePath: path,
    projectVersion: "6000.3.10f1",
  });
  await expect(inspectRampageWorkspace("relative-path")).rejects.toThrow("absolute checkout path");
});

test("other Unity projects cannot be registered as Rampage slots", async () => {
  const path = await fixture();
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "other-client" }));
  await expect(inspectRampageWorkspace(path)).rejects.toThrow("not the Rampage client");
  await writeFile(join(path, "package.json"), JSON.stringify({ name: "rampage-client" }));
  await writeFile(
    join(path, "Assets/Rampage/Editor/ArgusLabs.Rampage.Editor.asmdef"),
    JSON.stringify({ name: "Other.Editor" }),
  );
  await expect(inspectRampageWorkspace(path)).rejects.toThrow("not the Rampage client");
});

test("linked worktrees and shared Git common directories cannot be adopted", async () => {
  const path = await fixture();
  await rm(join(path, ".git"), { recursive: true });
  await writeFile(join(path, ".git"), "gitdir: /other/.git/worktrees/slot\n");
  await expect(inspectRampageWorkspace(path)).rejects.toThrow("own .git directory");
  await rm(join(path, ".git"));
  await mkdir(join(path, ".git"));
  await writeFile(join(path, ".git/commondir"), "/other/.git\n");
  await expect(inspectRampageWorkspace(path)).rejects.toThrow("Shared Git common directories");
});

test("shared source, settings, caches and lock directories are refused before adoption", async () => {
  for (const directory of ["Assets", "Packages", "ProjectSettings", "Library", "Temp"]) {
    const path = await fixture();
    const outside = await fixture();
    await rm(join(path, directory), { recursive: true, force: true });
    await symlink(outside, join(path, directory));
    await expect(inspectRampageWorkspace(path)).rejects.toThrow(
      `${directory} resolves outside the checkout`,
    );
  }
});

test("dangling optional caches and symlinked Git metadata are not treated as independent directories", async () => {
  const path = await fixture();
  await symlink(join(path, "missing"), join(path, "Library"));
  await expect(inspectRampageWorkspace(path)).rejects.toThrow("Cannot inspect Library");
  await rm(join(path, "Library"));
  await rm(join(path, ".git"), { recursive: true });
  const other = await fixture();
  await symlink(join(other, ".git"), join(path, ".git"));
  await expect(inspectRampageWorkspace(path)).rejects.toThrow("own .git directory");
});

test("missing, unreadable and ambiguous Unity versions cannot create a ready slot", async () => {
  const path = await fixture();
  const marker = join(path, "ProjectSettings/ProjectVersion.txt");
  await rm(marker);
  await expect(inspectRampageWorkspace(path)).rejects.toThrow(
    "Cannot inspect ProjectSettings/ProjectVersion.txt",
  );
  await mkdir(marker);
  await expect(inspectRampageWorkspace(path)).rejects.toThrow();
  await rm(marker, { recursive: true });
  for (const version of [
    "m_EditorVersion: unknown\n",
    "m_EditorVersion: 6000.3.10f1\nm_EditorVersion: 6000.3.10f1\n",
  ]) {
    await writeFile(marker, version);
    await expect(inspectRampageWorkspace(path)).rejects.toThrow("unambiguous Unity Editor version");
  }
});

test("malformed manifests cannot create a ready slot", async () => {
  const path = await fixture();
  for (const manifest of [
    "not JSON",
    "[]",
    '{"dependencies":null}',
    '{"dependencies":{"package":42}}',
  ]) {
    await writeFile(join(path, "Packages/manifest.json"), manifest);
    await expect(inspectRampageWorkspace(path)).rejects.toThrow();
  }
});

test("a Unity lock blocks handoff and is preserved for manual inspection", async () => {
  const path = await fixture();
  await mkdir(join(path, "Temp"));
  const lock = join(path, "Temp/UnityLockfile");
  await writeFile(lock, "owned-or-stale");
  await expect(assertWorkspaceStopped(path, undefined, stopped)).rejects.toThrow(
    "UnityLockfile is present",
  );
  expect(await readFile(lock, "utf8")).toBe("owned-or-stale");
  await rm(lock);
  await assertWorkspaceStopped(path, undefined, stopped);
});

test("main Editors and external MPPM clones block handoff without a Pipeline descriptor", async () => {
  const path = await fixture();
  await expect(
    assertWorkspaceStopped(path, undefined, {
      listEditors: async () => [{ pid: 41, projectPath: path }],
    }),
  ).rejects.toThrow("Unity Editor 41 is still using this slot");
  const clone = await fixture();
  await rm(join(clone, "Assets"), { recursive: true });
  await symlink(join(path, "Assets"), join(clone, "Assets"));
  await expect(
    assertWorkspaceStopped(path, undefined, {
      listEditors: async () => [{ pid: 42, projectPath: clone }],
    }),
  ).rejects.toThrow("Unity Editor 42 is still using this slot");
  const unrelated = await fixture();
  await assertWorkspaceStopped(path, undefined, {
    listEditors: async () => [{ pid: 43, projectPath: unrelated }],
  });
});

test("an unknown Editor or failed process inventory cannot make a slot available", async () => {
  const path = await fixture();
  await expect(
    assertWorkspaceStopped(path, undefined, {
      listEditors: async () => [{ pid: 44, projectPath: null }],
    }),
  ).rejects.toThrow("no verifiable project path");
  await expect(
    assertWorkspaceStopped(path, undefined, {
      listEditors: async () => {
        throw new Error("process inventory permission denied");
      },
    }),
  ).rejects.toThrow("process inventory permission denied");
  await expect(
    assertWorkspaceStopped(path, undefined, {
      listEditors: async () => [{ pid: 45, projectPath: join(path, "missing-project") }],
    }),
  ).rejects.toThrow();
});

test("a Unity lock appearing during process inspection still blocks handoff", async () => {
  const path = await fixture();
  await mkdir(join(path, "Temp"));
  await expect(
    assertWorkspaceStopped(path, undefined, {
      listEditors: async () => {
        await writeFile(join(path, "Temp/UnityLockfile"), "opened-during-inspection");
        return [];
      },
    }),
  ).rejects.toThrow("UnityLockfile is present");
});

test("cancelled inspection cannot turn an unfinished handoff into success", async () => {
  const path = await fixture();
  const controller = new AbortController();
  await expect(
    assertWorkspaceStopped(path, controller.signal, {
      listEditors: async () => {
        controller.abort(new Error("handoff cancelled"));
        return [];
      },
    }),
  ).rejects.toThrow("handoff cancelled");
});

test.skipIf(process.platform !== "linux")(
  "OS inspection detects a live synthetic Editor process outside Pipeline discovery",
  async () => {
    const path = await fixture();
    // This harmless shell fixture is named Unity so it exercises real ps + /proc inspection.
    const binary = join(path, "Unity");
    await writeFile(binary, "#!/bin/sh\nwhile :; do sleep 1; done\n", { mode: 0o700 });
    const child = spawn(binary, ["-projectPath", path], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      await expect(assertWorkspaceStopped(path)).rejects.toThrow(
        `Unity Editor ${child.pid} is still using this slot`,
      );
    } finally {
      const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exit;
    }
    await assertWorkspaceStopped(path);
  },
);
