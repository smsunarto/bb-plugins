import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  changedPluginFiles,
  findInstalledPlugin,
  snapshotPluginFiles,
} from "./dev-plugin";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-dev-plugin-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("snapshotPluginFiles", () => {
  test("tracks source files and excludes generated or dependency trees", async () => {
    const root = await temporaryDirectory();
    await Promise.all([
      mkdir(join(root, "components"), { recursive: true }),
      mkdir(join(root, "dist"), { recursive: true }),
      mkdir(join(root, "node_modules", "package"), { recursive: true }),
      mkdir(join(root, "types"), { recursive: true }),
      mkdir(join(root, ".next"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, "server.ts"), "export default 1;\n"),
      writeFile(join(root, "components", "button.tsx"), "export {};\n"),
      writeFile(join(root, "dist", "app.js"), "generated\n"),
      writeFile(join(root, "node_modules", "package", "index.js"), "dep\n"),
      writeFile(join(root, "types", "sdk.d.ts"), "generated\n"),
      writeFile(join(root, ".next", "build.js"), "generated\n"),
    ]);

    const snapshot = await snapshotPluginFiles(root);

    expect([...snapshot.keys()].sort()).toEqual([
      "components/button.tsx",
      "server.ts",
    ]);
  });
});

describe("changedPluginFiles", () => {
  test("reports added, changed, and removed files", () => {
    const previous = new Map([
      ["changed.ts", "1"],
      ["removed.ts", "1"],
      ["same.ts", "1"],
    ]);
    const next = new Map([
      ["added.ts", "1"],
      ["changed.ts", "2"],
      ["same.ts", "1"],
    ]);

    expect(changedPluginFiles(previous, next)).toEqual([
      "added.ts",
      "changed.ts",
      "removed.ts",
    ]);
  });
});

describe("findInstalledPlugin", () => {
  test("matches the installed source path instead of only the plugin id", async () => {
    const localRoot = await temporaryDirectory();
    const otherRoot = await temporaryDirectory();
    const installed = [{ id: "sidebar", rootDir: otherRoot }];

    expect(await findInstalledPlugin(installed, localRoot)).toBeUndefined();
    expect(
      await findInstalledPlugin(
        [...installed, { id: "local", rootDir: localRoot }],
        localRoot,
      ),
    ).toEqual({ id: "local", rootDir: localRoot });
  });
});
