import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories: string[] = [];
const adapter = resolve(import.meta.dir, "bb-dev-cli");

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bb-dev-cli", () => {
  test("delegates from the caller directory to the source bb-kit exec command", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-dev-cli-test-"));
    temporaryDirectories.push(root);
    const pluginDir = join(root, "plugin");
    const binDir = join(root, "bin");
    const capture = join(root, "capture.txt");
    await Promise.all([mkdir(pluginDir), mkdir(binDir)]);
    const fakeBun = join(binDir, "bun");
    await writeFile(
      fakeBun,
      `#!/usr/bin/env bash\nprintf 'cwd=%s\\n' "$PWD" > "${capture}"\nprintf '<%s>\\n' "$@" >> "${capture}"\n`,
    );
    await chmod(fakeBun, 0o755);

    const child = Bun.spawn([adapter, "plugin", "build", "."], {
      cwd: pluginDir,
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const output = await Bun.file(capture).text();
    expect(output).toContain(`cwd=${await realpath(pluginDir)}`);
    expect(output).toContain("<dev-instance>");
    expect(output).toContain("<exec>");
    expect(output).toContain("<-->");
    expect(output).toContain("<plugin>");
    expect(output).toContain("<build>");
    expect(output).toContain("<.>");
    expect(output).toContain("packages/bb-kit-core/src/bin/bin.ts");
  });
});
