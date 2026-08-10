import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const SCRIPT = join(import.meta.dir, "split-layers.ts");

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bb-split-layers-test-"));
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

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function repository(): Promise<string> {
  const cwd = await temporaryDirectory();
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.name", "Split Layers Test"]);
  git(cwd, ["config", "user.email", "split-layers@example.com"]);
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/solo.txt"), "base solo\n");
  await writeFile(join(cwd, "src/shared.txt"), "base shared\n");
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", "test: base"]);
  return cwd;
}

// The finished state both scenarios split: solo.txt owned by one layer,
// shared.txt built up across two.
async function fixtures(): Promise<string> {
  const work = await temporaryDirectory();
  for (const [path, content] of [
    ["final/src/solo.txt", "final solo\n"],
    ["final/src/shared.txt", "line one\nline two\n"],
    ["stage-l1/shared.txt", "line one\n"],
  ] as const) {
    await mkdir(dirname(join(work, path)), { recursive: true });
    await writeFile(join(work, path), content);
  }
  await writeFile(
    join(work, "manifest.json"),
    JSON.stringify({
      snapshotDir: join(work, "final"),
      branchMode: "git",
      layers: [
        {
          branch: "split/one",
          message: "feat(one): start shared",
          stage: { "src/shared.txt": join(work, "stage-l1/shared.txt") },
        },
        {
          branch: "split/two",
          message: "feat(two): finish shared, own solo",
          files: ["src/solo.txt", "src/shared.txt"],
        },
      ],
    }),
  );
  return join(work, "manifest.json");
}

function runScript(
  cwd: string,
  manifest: string,
): { code: number; output: string } {
  try {
    const output = execFileSync("bun", [SCRIPT, manifest], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("split-layers", () => {
  test("builds layers bottom-up and the top matches the snapshot", async () => {
    const cwd = await repository();
    const manifest = await fixtures();

    const result = runScript(cwd, manifest);
    expect(result.output).toContain("OK — top of stack matches the snapshot");
    expect(result.code).toBe(0);

    // Layer one holds only the intermediate shared state.
    expect(git(cwd, ["show", "split/one:src/shared.txt"])).toBe("line one\n");
    expect(git(cwd, ["show", "split/one:src/solo.txt"])).toBe("base solo\n");
    expect(git(cwd, ["log", "-1", "--format=%s", "split/one"])).toBe(
      "feat(one): start shared\n",
    );

    // Layer two finishes both files and matches the snapshot.
    expect(git(cwd, ["show", "split/two:src/shared.txt"])).toBe(
      "line one\nline two\n",
    );
    expect(git(cwd, ["show", "split/two:src/solo.txt"])).toBe("final solo\n");
    // Stacked: layer one is an ancestor of layer two.
    expect(() =>
      git(cwd, ["merge-base", "--is-ancestor", "split/one", "split/two"]),
    ).not.toThrow();
  });

  test("refuses a dirty tree before creating anything", async () => {
    const cwd = await repository();
    const manifest = await fixtures();
    await writeFile(join(cwd, "src/solo.txt"), "uncommitted\n");

    const result = runScript(cwd, manifest);
    expect(result.code).toBe(1);
    expect(result.output).toContain("working tree is dirty");
    expect(() => git(cwd, ["rev-parse", "--verify", "split/one"])).toThrow();
  });

  test("refuses when a layer branch already exists", async () => {
    const cwd = await repository();
    const manifest = await fixtures();
    git(cwd, ["branch", "split/two"]);

    const result = runScript(cwd, manifest);
    expect(result.code).toBe(1);
    expect(result.output).toContain("branch already exists: split/two");
    expect(() => git(cwd, ["rev-parse", "--verify", "split/one"])).toThrow();
  });

  test("refuses a snapshot file no layer finishes", async () => {
    const cwd = await repository();
    const work = await temporaryDirectory();
    await mkdir(join(work, "final/src"), { recursive: true });
    await writeFile(join(work, "final/src/solo.txt"), "final solo\n");
    const manifest = join(work, "manifest.json");
    await writeFile(
      manifest,
      JSON.stringify({
        snapshotDir: join(work, "final"),
        branchMode: "git",
        layers: [{ branch: "split/one", message: "feat: partial", files: [] }],
      }),
    );

    const result = runScript(cwd, manifest);
    expect(result.code).toBe(1);
    expect(result.output).toContain("no layer lists in `files`");
  });
});
