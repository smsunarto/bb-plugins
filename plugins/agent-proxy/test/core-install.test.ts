import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanStaleStaging, installCore, installedVersion } from "../lib/core-install.ts";
import { buildPaths } from "../lib/paths.ts";
import { assetName, type Release } from "../lib/release.ts";

function makeFixture(version: string) {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-install-"));
  const paths = buildPaths(join(dir, "data"));
  mkdirSync(paths.coreDir, { recursive: true });

  // Build a real tar.gz containing a fake binary, like the upstream archive.
  const archiveSrc = join(dir, "src");
  mkdirSync(archiveSrc, { recursive: true });
  const binaryContent = `#!/bin/sh\necho fake CLIProxyAPI v${version}\n`;
  writeFileSync(join(archiveSrc, "CLIProxyAPI"), binaryContent);
  chmodSync(join(archiveSrc, "CLIProxyAPI"), 0o644);
  writeFileSync(join(archiveSrc, "README.md"), "docs");
  const name = assetName(version);
  const archivePath = join(dir, name);
  execFileSync("tar", ["-czf", archivePath, "-C", archiveSrc, "."]);

  const archiveBytes = readFileSync(archivePath);
  const sha = createHash("sha256").update(archiveBytes).digest("hex");
  const checksums = `${sha}  ${name}\n`;

  const release: Release = {
    version,
    assets: [
      { name, url: `https://example.com/${name}` },
      { name: "checksums.txt", url: "https://example.com/checksums.txt" },
    ],
  };

  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    if (url.endsWith(name)) {
      return Promise.resolve(new Response(new Uint8Array(archiveBytes)));
    }
    if (url.endsWith("checksums.txt")) {
      return Promise.resolve(new Response(checksums));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  return { dir, paths, release, name, archiveBytes, fetchImpl };
}

test("installCore downloads, verifies, extracts, and lands atomically", async () => {
  const { paths, release, fetchImpl } = makeFixture("7.2.121");
  const stages: string[] = [];
  const version = await installCore(paths, release, {
    fetchImpl,
    onProgress: (stage) => stages.push(stage),
  });
  assert.equal(version, "7.2.121");
  assert.deepEqual(stages, ["downloading", "verifying", "extracting", "installing", "done"]);
  assert.equal(installedVersion(paths), "7.2.121");
  assert.ok(existsSync(paths.binPath));
  // chmod 755 applied
  const mode = (await import("node:fs")).statSync(paths.binPath).mode & 0o777;
  assert.equal(mode, 0o755);
  // staging cleaned
  const leftovers = (await import("node:fs"))
    .readdirSync(paths.coreDir)
    .filter((entry) => entry.startsWith("tmp-"));
  assert.deepEqual(leftovers, []);
});

test("checksum mismatch aborts and leaves the previous binary", async () => {
  const { paths, release, name, fetchImpl } = makeFixture("7.2.121");
  // Pre-install an older binary that must survive the failed update.
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(paths.binPath, "old-binary");
  writeFileSync(paths.versionMarker, "7.0.0\n");

  const corruptFetch: typeof fetch = (input) => {
    const url = String(input);
    if (url.endsWith("checksums.txt")) {
      return Promise.resolve(new Response(`${"0".repeat(64)}  ${name}\n`));
    }
    return fetchImpl(input);
  };

  await assert.rejects(
    installCore(paths, release, { fetchImpl: corruptFetch }),
    /checksum mismatch/,
  );
  assert.equal(readFileSync(paths.binPath, "utf8"), "old-binary");
  assert.equal(installedVersion(paths), "7.0.0");
});

test("missing asset yields a clear error", async () => {
  const { paths, fetchImpl } = makeFixture("7.2.121");
  const release: Release = { version: "7.2.121", assets: [] };
  await assert.rejects(installCore(paths, release, { fetchImpl }), /no asset named/);
});

test("installedVersion requires the binary, not just the marker", () => {
  const { paths } = makeFixture("7.2.121");
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(paths.versionMarker, "9.9.9\n");
  assert.equal(installedVersion(paths), null);
});

test("cleanStaleStaging removes only tmp dirs", () => {
  const { paths } = makeFixture("7.2.121");
  mkdirSync(join(paths.coreDir, "tmp-123"), { recursive: true });
  mkdirSync(join(paths.coreDir, "auth"), { recursive: true });
  cleanStaleStaging(paths.coreDir);
  assert.equal(existsSync(join(paths.coreDir, "tmp-123")), false);
  assert.equal(existsSync(join(paths.coreDir, "auth")), true);
});
