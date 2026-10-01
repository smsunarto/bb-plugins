import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_PAYLOAD_LIMIT_BYTES } from "../../shared/contracts/host-contract.ts";
import { diffrExecutable } from "../../shared/node/vendor/review/src/server/structural-diff.ts";
import { ReviewInputError } from "../../shared/vendor/review/src/review-api/input-error.ts";
import { BLOB_RESPONSE_BYTES, closeBlobReaders, readBlobs } from "./blobs.ts";
import { failure, hostResult } from "./codec.ts";
import { invoke, probe } from "./invoke.ts";
import { WHITEBOARD_APP_RUNTIMES, findReviewPackageRoot } from "./package-root.ts";

const APP_RUNTIME = "/Applications/Whiteboard.app/Contents/Resources/app/review-runtime";
const PLUGIN_ROOT = path.resolve(import.meta.dirname, "../../..");
const temps: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const temp of temps.splice(0)) rmSync(temp, { recursive: true, force: true });
});

/** A fake Whiteboard runtime directory, with or without `bin/diffr`. */
function runtime(withDiffr: boolean) {
  const root = mkdtempSync(path.join(tmpdir(), "whiteboard-runtime-"));
  temps.push(root);
  if (withDiffr) {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin/diffr"), "", { mode: 0o755 });
  }
  return root;
}

describe("diffr resolution", () => {
  const hostModule = pathToFileURL(path.join(PLUGIN_ROOT, "src/host/lib/package-root.ts")).href;

  it("REVIEW_DIFFR_BINARY wins over a runtime that carries diffr", () => {
    vi.stubEnv("REVIEW_DIFFR_BINARY", "/opt/custom/diffr");
    const withDiffr = runtime(true);
    expect(diffrExecutable(findReviewPackageRoot(hostModule, [withDiffr]))).toBe(
      "/opt/custom/diffr",
    );
  });

  it("then the first Whiteboard.app runtime with bin/diffr", () => {
    vi.stubEnv("REVIEW_DIFFR_BINARY", "");
    const without = runtime(false);
    const withDiffr = runtime(true);
    expect(findReviewPackageRoot(hostModule, [without, withDiffr])).toBe(withDiffr);
    expect(diffrExecutable(findReviewPackageRoot(hostModule, [without, withDiffr]))).toBe(
      path.join(withDiffr, "bin/diffr"),
    );
  });

  it("then diffr on PATH, when no runtime has it and the plugin root has no bin/diffr", () => {
    vi.stubEnv("REVIEW_DIFFR_BINARY", "");
    expect(findReviewPackageRoot(hostModule, [runtime(false)])).toBe(PLUGIN_ROOT);
    expect(existsSync(path.join(PLUGIN_ROOT, "bin/diffr"))).toBe(false);
    expect(diffrExecutable(findReviewPackageRoot(hostModule, [runtime(false)]))).toBe("diffr");
  });

  it("looks in /Applications and ~/Applications", () => {
    expect(WHITEBOARD_APP_RUNTIMES).toEqual([
      APP_RUNTIME,
      path.join(
        process.env.HOME!,
        "Applications/Whiteboard.app/Contents/Resources/app/review-runtime",
      ),
    ]);
  });

  it.skipIf(!existsSync(path.join(APP_RUNTIME, "bin/diffr")))(
    "finds the installed Whiteboard.app diffr by default",
    () => {
      vi.stubEnv("REVIEW_DIFFR_BINARY", "");
      expect(diffrExecutable()).toBe(path.join(APP_RUNTIME, "bin/diffr"));
    },
  );
});

describe("probe", () => {
  it("reports the platform, git, gh, jj and the diffr that answered", async () => {
    vi.stubEnv("REVIEW_DIFFR_BINARY", "");
    const has = (file: string) =>
      (process.env.PATH ?? "")
        .split(path.delimiter)
        .some((dir) => existsSync(path.join(dir, file)));
    expect(await probe()).toEqual({
      platform: process.platform,
      git: true,
      gh: has("gh"),
      jj: has("jj"),
      diffr: existsSync(path.join(APP_RUNTIME, "bin/diffr"))
        ? path.join(APP_RUNTIME, "bin/diffr")
        : has("diffr")
          ? "diffr"
          : null,
    });
  });

  it("answers diffr null when the configured diffr does not run", async () => {
    vi.stubEnv("REVIEW_DIFFR_BINARY", path.join(tmpdir(), "whiteboard-missing-diffr"));
    expect((await probe()).diffr).toBeNull();
  });
});

describe("host results", () => {
  it("refuses a result above the transfer limit with PayloadTooLarge", () => {
    const value = "x".repeat(HOST_PAYLOAD_LIMIT_BYTES);
    expect(hostResult(value)).toEqual({
      ok: false,
      error: {
        name: "PayloadTooLarge",
        message: `whiteboard: the host result is ${HOST_PAYLOAD_LIMIT_BYTES + 2} bytes, above the 7340032-byte host transfer limit.`,
      },
    });
    expect(hostResult(undefined)).toEqual({ ok: true });
    expect(hostResult({ big: 12n, bytes: new Uint8Array([1, 2]) })).toEqual({
      ok: true,
      value: { big: { $bigint: "12" }, bytes: { $bytes: "AQI=" } },
    });
  });

  it("names ReviewInputError so the server can rebuild it with its status", () => {
    expect(failure(new ReviewInputError("Repository not found.", 404))).toEqual({
      ok: false,
      error: { name: "ReviewInputError", message: "Repository not found.", status: 404 },
    });
  });

  it("invoke rejects functions outside the allowlist, including inherited names", async () => {
    const controller = new AbortController();
    expect(await invoke({ module: "fs", fn: "toString", args: [] }, controller.signal)).toEqual({
      ok: false,
      error: {
        name: "unknown_function",
        message: "whiteboard: fs.toString is not an allowlisted host function.",
      },
    });
  });
});

describe("readBlobs", () => {
  it("answers the in-order prefix that fits the response budget, across read windows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "whiteboard-blobs-"));
    temps.push(root);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd: root,
        encoding: "utf8",
      });
    git("init", "-q");
    // 150 blobs of 30 000 bytes: 40 000 bytes of base64 each, so 104 fit in 4 MiB.
    for (let index = 0; index < 150; index++)
      writeFileSync(path.join(root, `f${index}.txt`), String(index % 10).repeat(30_000));
    git("add", "-A");
    git("commit", "-qm", "blobs");
    const commit = git("rev-parse", "HEAD").trim();
    const paths = Array.from({ length: 150 }, (_, index) => `f${index}.txt`);
    // A missing path answers null and costs no budget.
    paths.splice(70, 0, "missing.txt");
    try {
      const { items } = await readBlobs(
        { rootPath: root, kind: "git", items: paths.map((file) => ({ commit, path: file })) },
        new AbortController().signal,
      );
      expect(Math.floor(BLOB_RESPONSE_BYTES / 40_000)).toBe(104);
      expect(items.length).toBe(105);
      expect(items[70]).toEqual({ bytes: null });
      expect(Buffer.from(items[0]!.bytes!, "base64").toString()).toBe("0".repeat(30_000));
      expect(Buffer.from(items[104]!.bytes!, "base64").toString()).toBe("3".repeat(30_000));
    } finally {
      await closeBlobReaders();
    }
  });
});
