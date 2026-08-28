import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
const shim = resolve(import.meta.dir, "bb-dev-cli");

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-dev-cli-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runShim(args: string[]): Promise<string[]> {
  const root = await temporaryDirectory();
  const pluginDir = join(root, "plugin");
  const devRepo = join(root, "bb");
  const binDir = join(root, "bin");
  await Promise.all([
    mkdir(pluginDir, { recursive: true }),
    mkdir(devRepo, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);

  const fakePnpm = join(binDir, "pnpm");
  await writeFile(fakePnpm, '#!/usr/bin/env bash\nprintf "<%s>\\n" "$@"\n');
  await chmod(fakePnpm, 0o755);

  const child = Bun.spawn([shim, ...args], {
    cwd: pluginDir,
    env: {
      ...process.env,
      BB_DEV_REPO: devRepo,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  return stdout.trim().split("\n");
}

describe("bb-dev-cli", () => {
  test("resolves a dot plugin path before pnpm changes the working directory", async () => {
    const output = await runShim(["plugin", "build", "."]);
    expect(output.at(-1)).toMatch(/\/plugin>$/);
  });

  test("supplies the caller directory when a local plugin command omits its path", async () => {
    const output = await runShim(["plugin", "types", "--check"]);
    expect(output.slice(-2)).toEqual([expect.stringMatching(/\/plugin>$/), "<--check>"]);
  });
});
