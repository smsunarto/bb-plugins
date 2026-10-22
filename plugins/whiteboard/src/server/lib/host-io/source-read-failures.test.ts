import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BlobBatchReader } from "../../../shared/node/vendor/local-vcs/src/blob-batch-reader.ts";
import * as vcs from "./local-vcs.ts";
import { type GitFixture, gitFixture } from "./testing/git-fixture.ts";
import { installInProcessHostIo } from "./testing/in-process.ts";

let repo: GitFixture;
let uninstall: () => void;

beforeEach(() => {
  repo = gitFixture("whiteboard-read-failures-");
  ({ uninstall } = installInProcessHostIo());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  uninstall();
  repo.remove();
});

it.each([6, 11])("isolates a %i MiB blob from small reads in the same host batch", async (mib) => {
  repo.write("large.txt", Buffer.alloc(mib * 1024 * 1024, 97));
  const commit = repo.commit("large source");
  const reader = vcs.createBlobBatchReader({ rootPath: repo.root, kind: "git" });
  const input = { rootPath: repo.root, kind: "git" as const, commit, reader };
  try {
    const answers = await Promise.allSettled([
      vcs.readFileAtCommit({ ...input, relativePath: "src/a.ts" }),
      vcs.readFileAtCommit({ ...input, relativePath: "large.txt" }),
      vcs.readFileAtCommit({ ...input, relativePath: "docs/readme.md" }),
    ]);
    expect(answers[0]).toEqual({
      status: "fulfilled",
      value: "export const a = 10;\nexport const a2 = 20;\n",
    });
    expect(answers[1]).toMatchObject({ status: "rejected", reason: expect.any(Error) });
    expect(answers[2]).toEqual({ status: "fulfilled", value: "# Readme\n" });
  } finally {
    await reader.close();
  }
});

it.each(["git", "jj"] as const)(
  "preserves reader failures through the %s host invocation",
  async (kind) => {
    vi.spyOn(BlobBatchReader.prototype, "readObject").mockRejectedValue(
      new Error("cat-file stopped"),
    );
    await expect(
      vcs.readFileAtCommit({
        rootPath: repo.root,
        kind,
        commit: repo.head,
        relativePath: "src/a.ts",
      }),
    ).rejects.toThrow("cat-file stopped");
  },
);

it.each(["git", "jj"] as const)(
  "preserves oversized results through the %s host invocation",
  async (kind) => {
    repo.write("large.txt", Buffer.alloc(11 * 1024 * 1024, 97));
    const commit = repo.commit("large source");
    await expect(
      vcs.readFileAtCommit({ rootPath: repo.root, kind, commit, relativePath: "large.txt" }),
    ).rejects.toThrow(/reader limit/);
  },
);

it.each(["missing", "list-failure", "show-failure", "show-overflow", "text"])(
  "keeps jj %s distinct through the production host invocation",
  async (mode) => {
    // Fault-inject the external jj process while retaining the real host route,
    // Git object reader, wire codec, and execFile/maxBuffer behavior.
    const bin = mkdtempSync(path.join(tmpdir(), "whiteboard-jj-process-"));
    const executable = path.join(bin, "jj");
    writeFileSync(
      executable,
      `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("git")) process.stdout.write(process.cwd() + "/.git");
else if (args.includes("list")) {
  if (${JSON.stringify(mode)} === "list-failure") process.exit(2);
  if (${JSON.stringify(mode)} !== "missing") process.stdout.write("present");
} else if (args.includes("show")) {
  if (${JSON.stringify(mode)} === "show-failure") process.exit(2);
  if (${JSON.stringify(mode)} === "show-overflow") process.stdout.write(Buffer.alloc(11 * 1024 * 1024, 97));
  else process.stdout.write("jj source");
} else process.exit(2);
`,
    );
    chmodSync(executable, 0o755);
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    try {
      const result = vcs.readFileAtCommit({
        rootPath: repo.root,
        kind: "jj",
        commit: "jj-only-revision",
        relativePath: "source.ts",
      });
      if (mode === "missing") await expect(result).resolves.toBeNull();
      else if (mode === "text") await expect(result).resolves.toBe("jj source");
      else await expect(result).rejects.toThrow();
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  },
);
