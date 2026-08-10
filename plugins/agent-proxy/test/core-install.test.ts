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
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanStaleStaging,
  installCore,
  installedVersion,
  migrateLegacyInstall,
} from "../lib/core-install.ts";
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
  writeFileSync(join(archiveSrc, "cli-proxy-api"), binaryContent);
  chmodSync(join(archiveSrc, "cli-proxy-api"), 0o644);
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

function seedInstalled(
  paths: ReturnType<typeof buildPaths>,
  version: string,
  content = "old-binary",
): void {
  const releaseDir = join(paths.versionsDir, `seed-${version}`);
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, "cli-proxy-api"), content);
  writeFileSync(join(releaseDir, ".version"), `${version}\n`);
  mkdirSync(paths.binDir, { recursive: true });
  symlinkSync(releaseDir, paths.currentLink, "dir");
}

test("installCore downloads, verifies, extracts, and lands atomically", async () => {
  const { paths, release, fetchImpl } = makeFixture("7.2.121");
  const stages: string[] = [];
  const version = await installCore(paths, release, {
    fetchImpl,
    onProgress: (stage) => stages.push(stage),
    beforeInstall: async () => {
      stages.push("swap");
    },
  });
  assert.equal(version, "7.2.121");
  assert.deepEqual(stages, ["downloading", "verifying", "extracting", "installing", "swap", "done"]);
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

test("successful update atomically switches binary and version together", async () => {
  const { paths, release, fetchImpl } = makeFixture("7.2.121");
  seedInstalled(paths, "7.0.0");
  await installCore(paths, release, { fetchImpl });
  assert.equal(installedVersion(paths), "7.2.121");
  assert.match(readFileSync(paths.binPath, "utf8"), /v7\.2\.121/);
});

test("checksum mismatch aborts and leaves the previous binary", async () => {
  const { paths, release, name, fetchImpl } = makeFixture("7.2.121");
  // Pre-install an older binary that must survive the failed update.
  seedInstalled(paths, "7.0.0");

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

test("missing checksum metadata fails closed", async () => {
  const { paths, release, fetchImpl } = makeFixture("7.2.121");
  const withoutChecksums = {
    ...release,
    assets: release.assets.filter((asset) => asset.name !== "checksums.txt"),
  };
  await assert.rejects(
    installCore(paths, withoutChecksums, { fetchImpl }),
    /ships no checksums\.txt/,
  );

  const missingEntryFetch: typeof fetch = (input) =>
    String(input).endsWith("checksums.txt")
      ? Promise.resolve(new Response(`${"a".repeat(64)}  some-other-asset.tar.gz\n`))
      : fetchImpl(input);
  await assert.rejects(
    installCore(paths, release, { fetchImpl: missingEntryFetch }),
    /has no entry.*refusing unverified install/,
  );
});

test("archive links are rejected before extraction", async () => {
  const { dir, paths, release, name } = makeFixture("7.2.121");
  const archiveSrc = join(dir, "unsafe-src");
  mkdirSync(archiveSrc, { recursive: true });
  symlinkSync("/tmp/not-the-proxy", join(archiveSrc, "cli-proxy-api"));
  const archivePath = join(dir, "unsafe.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", archiveSrc, "."]);
  const archiveBytes = readFileSync(archivePath);
  const sha = createHash("sha256").update(archiveBytes).digest("hex");
  const fetchImpl: typeof fetch = (input) =>
    String(input).endsWith("checksums.txt")
      ? Promise.resolve(new Response(`${sha}  ${name}\n`))
      : Promise.resolve(new Response(new Uint8Array(archiveBytes)));

  await assert.rejects(installCore(paths, release, { fetchImpl }), /unsafe link entry/);
  assert.equal(existsSync(paths.binPath), false);
  rmSync(archiveSrc, { recursive: true, force: true });
});

test("abort cancels an in-flight archive download", async () => {
  const { paths, release, name } = makeFixture("7.2.121");
  const controller = new AbortController();
  const fetchImpl: typeof fetch = (input, init) => {
    if (!String(input).endsWith(name)) return Promise.resolve(new Response("not reached"));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  };
  const installing = installCore(paths, release, { fetchImpl, signal: controller.signal });
  controller.abort(new Error("disposed"));
  await assert.rejects(installing, /disposed/);
});

test("missing asset yields a clear error", async () => {
  const { paths, fetchImpl } = makeFixture("7.2.121");
  const release: Release = { version: "7.2.121", assets: [] };
  await assert.rejects(installCore(paths, release, { fetchImpl }), /no asset named/);
});

test("installedVersion requires the binary, not just the marker", () => {
  const { paths } = makeFixture("7.2.121");
  const releaseDir = join(paths.versionsDir, "marker-only");
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, ".version"), "9.9.9\n");
  mkdirSync(paths.binDir, { recursive: true });
  symlinkSync(releaseDir, paths.currentLink, "dir");
  assert.equal(installedVersion(paths), null);
});

test("migrateLegacyInstall publishes a complete pointer without deleting the legacy install", () => {
  const { paths } = makeFixture("7.2.121");
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(paths.legacyBinPath, "legacy-binary");
  writeFileSync(paths.legacyVersionMarker, "7.0.0\n");
  migrateLegacyInstall(paths);
  assert.equal(installedVersion(paths), "7.0.0");
  assert.equal(readFileSync(paths.binPath, "utf8"), "legacy-binary");
  assert.equal(readFileSync(paths.legacyBinPath, "utf8"), "legacy-binary");
});

test("cleanStaleStaging removes only tmp dirs", () => {
  const { paths } = makeFixture("7.2.121");
  mkdirSync(join(paths.coreDir, "tmp-123"), { recursive: true });
  mkdirSync(join(paths.coreDir, "auth"), { recursive: true });
  cleanStaleStaging(paths.coreDir);
  assert.equal(existsSync(join(paths.coreDir, "tmp-123")), false);
  assert.equal(existsSync(join(paths.coreDir, "auth")), true);
});
