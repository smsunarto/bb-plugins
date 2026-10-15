import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertNoSlotPreparation, provisionRampageSlot } from "./slot-provisioning.ts";

const exec = promisify(execFile);
const paths: string[] = [];
afterEach(async () => {
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const stopped = { listEditors: async () => [] };
const portableClone: typeof copyFile = async (source, destination, mode) => {
  expect(mode).toBe(constants.COPYFILE_FICLONE_FORCE);
  await copyFile(source, destination);
};

async function fixture(lfs = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bb-rampage-provision-")));
  paths.push(root);
  const sourcePath = join(root, "source");
  for (const directory of [
    "Assets/Rampage/Editor",
    "Packages",
    "ProjectSettings",
    "Library/Artifacts",
    "Library/Pipeline",
    "Library/VP/mppm-clone",
  ])
    await mkdir(join(sourcePath, directory), { recursive: true });
  for (const [file, value] of Object.entries({
    "package.json": JSON.stringify({ name: "rampage-client" }),
    "Assets/Rampage/Editor/ArgusLabs.Rampage.Editor.asmdef": JSON.stringify({
      name: "ArgusLabs.Rampage.Editor",
    }),
    "Packages/manifest.json": JSON.stringify({
      dependencies: { "com.unity.test-framework": "1.4.6" },
    }),
    "ProjectSettings/ProjectVersion.txt": "m_EditorVersion: 6000.3.10f1\n",
    ".gitignore": "Library/\nTemp/\n",
    "Library/Artifacts/warm.bin": "warm-source-cache",
    "Library/Pipeline/.unity-pipeline-port": "secret-native-token",
    "Library/VP/mppm-clone/identity": "source-mppm-identity",
  }))
    await writeFile(join(sourcePath, file), value);
  const git = async (...args: string[]) =>
    (
      await exec("git", ["-C", sourcePath, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_COMMITTER_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.test",
          GIT_COMMITTER_EMAIL: "fixture@example.test",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      })
    ).stdout.trim();
  await git("init", "-b", "main");
  await git("remote", "add", "origin", "https://github.com/Argus-Labs/rampage-client.git");
  if (lfs) {
    await git("lfs", "install", "--local", "--skip-repo");
    await writeFile(
      join(sourcePath, ".gitattributes"),
      "*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    await writeFile(join(sourcePath, "Assets/picture.png"), "test-large-file-asset");
  }
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await mkdir(join(sourcePath, ".git/gitbutler"));
  await writeFile(join(sourcePath, ".git/gitbutler/state"), "private-source-state");
  const input = {
    sourcePath,
    path: join(root, "slot"),
    branch: "scott/test-slot",
    operationId: "test-operation",
  };
  return { root, sourcePath, input, git, dataDir: join(root, "data") };
}

test("a provisioned checkout has independent Git and cache files, and completed retries preserve user work", async () => {
  const f = await fixture(true);
  const result = await provisionRampageSlot(f.input, f.dataDir, undefined, {
    inspection: stopped,
    cloneFile: portableClone,
  });
  expect(result).toEqual({
    workspacePath: f.input.path,
    projectVersion: "6000.3.10f1",
    sourceCommit: await f.git("rev-parse", "HEAD"),
    branch: "scott/test-slot",
    cacheSeed: "copy-on-write",
  });
  expect(await readFile(join(f.input.path, "Assets/picture.png"), "utf8")).toBe(
    "test-large-file-asset",
  );
  expect(await readdir(join(f.input.path, "Library"))).toEqual(["Artifacts"]);
  expect(await readdir(join(f.input.path, ".git"))).not.toContain("gitbutler");
  expect(
    (await exec("git", ["-C", f.input.path, "remote", "get-url", "origin"])).stdout.trim(),
  ).toBe("https://github.com/Argus-Labs/rampage-client.git");
  expect((await exec("git", ["-C", f.input.path, "branch", "--show-current"])).stdout.trim()).toBe(
    "scott/test-slot",
  );
  expect(
    (await lstat(join(f.input.path, "Library/Artifacts/warm.bin"))).ino ===
      (await lstat(join(f.sourcePath, "Library/Artifacts/warm.bin"))).ino,
  ).toBe(false);
  await writeFile(join(f.input.path, "Library/Artifacts/warm.bin"), "slot-mutated-cache");
  await writeFile(join(f.input.path, "package.json"), '{"name":"rampage-client","userEdit":true}');
  expect(
    await provisionRampageSlot(f.input, f.dataDir, undefined, {
      inspection: stopped,
      cloneFile: portableClone,
    }),
  ).toEqual(result);
  expect(await readFile(join(f.input.path, "Library/Artifacts/warm.bin"), "utf8")).toBe(
    "slot-mutated-cache",
  );
  expect(await readFile(join(f.sourcePath, "Library/Artifacts/warm.bin"), "utf8")).toBe(
    "warm-source-cache",
  );
  expect(await readFile(join(f.input.path, "package.json"), "utf8")).toBe(
    '{"name":"rampage-client","userEdit":true}',
  );
  await assertNoSlotPreparation(f.input.path, f.dataDir);
  await assertNoSlotPreparation(f.sourcePath, f.dataDir);
});

test("unsupported reflinks fail without fallback, and partial retries stay fenced", async () => {
  const f = await fixture();
  const cloneFile: typeof copyFile = async () => {
    throw Object.assign(new Error("CoW unsupported"), { code: "EOPNOTSUPP" });
  };
  await expect(
    provisionRampageSlot(f.input, f.dataDir, undefined, { inspection: stopped, cloneFile }),
  ).rejects.toThrow("CoW unsupported");
  expect(await readFile(join(f.sourcePath, "Library/Artifacts/warm.bin"), "utf8")).toBe(
    "warm-source-cache",
  );
  await expect(
    provisionRampageSlot(f.input, f.dataDir, undefined, {
      inspection: stopped,
      cloneFile: portableClone,
    }),
  ).rejects.toThrow("incomplete");
  const receipt = JSON.parse(
    await readFile(
      join(
        f.dataDir,
        "rampage-provisioning",
        (await readdir(join(f.dataDir, "rampage-provisioning")))[0]!,
      ),
      "utf8",
    ),
  );
  expect(receipt.state).toBe("failed");
  expect(await readFile(join(f.input.path, "package.json"), "utf8")).toBe(
    '{"name":"rampage-client"}',
  );
  await expect(assertNoSlotPreparation(f.input.path, f.dataDir)).rejects.toThrow(
    "incomplete provisioning",
  );
  await assertNoSlotPreparation(f.sourcePath, f.dataDir);
});

test("an existing destination is preserved and another operation cannot reuse its reservation", async () => {
  const f = await fixture();
  await mkdir(f.input.path);
  await writeFile(join(f.input.path, "precious"), "keep me");
  await expect(
    provisionRampageSlot(f.input, f.dataDir, undefined, {
      inspection: stopped,
      cloneFile: portableClone,
    }),
  ).rejects.toThrow("already exists");
  expect(await readFile(join(f.input.path, "precious"), "utf8")).toBe("keep me");
  await expect(
    provisionRampageSlot({ ...f.input, operationId: "other-operation" }, f.dataDir, undefined, {
      inspection: stopped,
    }),
  ).rejects.toThrow("another provisioning operation");
});

test("dirty source and running Editors cannot seed a ready checkout", async () => {
  const f = await fixture();
  await writeFile(join(f.sourcePath, "untracked"), "dirty source");
  await expect(
    provisionRampageSlot(f.input, f.dataDir, undefined, {
      inspection: stopped,
      cloneFile: portableClone,
    }),
  ).rejects.toThrow("no tracked or untracked changes");
  expect(await readFile(join(f.sourcePath, "untracked"), "utf8")).toBe("dirty source");
  const busy = await fixture();
  await expect(
    provisionRampageSlot(busy.input, busy.dataDir, undefined, {
      inspection: { listEditors: async () => [{ pid: 123, projectPath: busy.sourcePath }] },
    }),
  ).rejects.toThrow("still using this slot");
  expect(await readFile(join(busy.sourcePath, "Library/Artifacts/warm.bin"), "utf8")).toBe(
    "warm-source-cache",
  );
});

test("cache symlinks and Editor startup during provisioning never publish ready", async () => {
  const f = await fixture();
  await symlink("warm.bin", join(f.sourcePath, "Library/Artifacts/link"));
  await expect(
    provisionRampageSlot(f.input, f.dataDir, undefined, {
      inspection: stopped,
      cloneFile: portableClone,
    }),
  ).rejects.toThrow("symlink");
  expect(await readFile(join(f.sourcePath, "Library/Artifacts/link"), "utf8")).toBe(
    "warm-source-cache",
  );
  const changed = await fixture();
  let snapshots = 0;
  await expect(
    provisionRampageSlot(changed.input, changed.dataDir, undefined, {
      inspection: {
        listEditors: async () =>
          ++snapshots === 1 ? [] : [{ pid: 123, projectPath: changed.sourcePath }],
      },
      cloneFile: portableClone,
    }),
  ).rejects.toThrow("still using this slot");
  await expect(
    provisionRampageSlot(changed.input, changed.dataDir, undefined, { inspection: stopped }),
  ).rejects.toThrow("incomplete");
});

test("cancellation leaves a fenced partial checkout with no ready result", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const cloneFile: typeof copyFile = async (source, destination, mode) => {
    await portableClone(source, destination, mode);
    controller.abort(new Error("provision canceled"));
  };
  await expect(
    provisionRampageSlot(f.input, f.dataDir, controller.signal, { inspection: stopped, cloneFile }),
  ).rejects.toThrow("provision canceled");
  expect(await readFile(join(f.sourcePath, "Library/Artifacts/warm.bin"), "utf8")).toBe(
    "warm-source-cache",
  );
  await expect(
    provisionRampageSlot(f.input, f.dataDir, undefined, { inspection: stopped }),
  ).rejects.toThrow("incomplete");
});

test("concurrent provisioning cannot enter a reserved target, including the same operation", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const copying = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = provisionRampageSlot(f.input, f.dataDir, undefined, {
    inspection: stopped,
    cloneFile: async (source, destination, mode) => {
      entered();
      await blocked;
      await portableClone(source, destination, mode);
    },
  });
  await copying;
  try {
    await expect(assertNoSlotPreparation(f.input.path, f.dataDir)).rejects.toThrow(
      "incomplete provisioning",
    );
    await expect(assertNoSlotPreparation(f.sourcePath, f.dataDir)).rejects.toThrow(
      "running provisioning process",
    );
    await expect(
      provisionRampageSlot(f.input, f.dataDir, undefined, { inspection: stopped }),
    ).rejects.toThrow("incomplete");
    await expect(
      provisionRampageSlot(
        { ...f.input, operationId: "concurrent-operation" },
        f.dataDir,
        undefined,
        { inspection: stopped },
      ),
    ).rejects.toThrow("another provisioning operation");
  } finally {
    release();
  }
  expect((await pending).cacheSeed).toBe("copy-on-write");
  expect(await readFile(join(f.input.path, "Library/Artifacts/warm.bin"), "utf8")).toBe(
    "warm-source-cache",
  );
  await assertNoSlotPreparation(f.input.path, f.dataDir);
  await assertNoSlotPreparation(f.sourcePath, f.dataDir);
});

test("source changes and missing local LFS objects leave no ready checkout", async () => {
  const f = await fixture();
  await expect(
    provisionRampageSlot(f.input, f.dataDir, undefined, {
      inspection: stopped,
      cloneFile: async (source, destination, mode) => {
        await portableClone(source, destination, mode);
        await writeFile(
          join(f.sourcePath, "package.json"),
          '{"name":"rampage-client","raced":true}',
        );
      },
    }),
  ).rejects.toThrow("no tracked or untracked changes");
  expect(await readFile(join(f.sourcePath, "package.json"), "utf8")).toBe(
    '{"name":"rampage-client","raced":true}',
  );
  const missingLfs = await fixture(true);
  await rm(join(missingLfs.sourcePath, ".git/lfs/objects"), { recursive: true });
  await expect(
    provisionRampageSlot(missingLfs.input, missingLfs.dataDir, undefined, {
      inspection: stopped,
      cloneFile: portableClone,
    }),
  ).rejects.toThrow();
  await expect(
    provisionRampageSlot(missingLfs.input, missingLfs.dataDir, undefined, { inspection: stopped }),
  ).rejects.toThrow("incomplete");
  expect(await readFile(join(missingLfs.sourcePath, "Assets/picture.png"), "utf8")).toBe(
    "test-large-file-asset",
  );
});

test("only a proven dead preparation owner permits source recovery, while its partial target stays fenced", async () => {
  const f = await fixture();
  await mkdir(f.input.path);
  await mkdir(join(f.dataDir, "rampage-provisioning"), { recursive: true });
  const completed = exec(process.execPath, ["-e", ""]);
  await completed;
  const receipt = {
    version: 1,
    input: f.input,
    owner: { pid: completed.child.pid, startedAt: "fixture" },
    state: "preparing",
  };
  const file = join(f.dataDir, "rampage-provisioning", "dead-owner.json");
  await writeFile(file, JSON.stringify(receipt));
  await assertNoSlotPreparation(f.sourcePath, f.dataDir);
  await expect(assertNoSlotPreparation(f.input.path, f.dataDir)).rejects.toThrow(
    "incomplete provisioning",
  );
  receipt.owner.pid = -1;
  await writeFile(file, JSON.stringify(receipt));
  await expect(assertNoSlotPreparation(f.sourcePath, f.dataDir)).rejects.toThrow(
    "Cannot verify the provisioning owner process",
  );
  expect(await readFile(join(f.sourcePath, "Library/Artifacts/warm.bin"), "utf8")).toBe(
    "warm-source-cache",
  );
  receipt.state = "failed";
  await writeFile(file, JSON.stringify(receipt));
  await assertNoSlotPreparation(f.sourcePath, f.dataDir);
  await expect(assertNoSlotPreparation(f.input.path, f.dataDir)).rejects.toThrow(
    "incomplete provisioning",
  );
});
