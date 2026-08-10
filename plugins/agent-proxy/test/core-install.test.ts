import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  cleanStaleStaging,
  fetchSourceRevision,
  installCore,
  installedVersion,
  migrateLegacyInstall,
  type BuildSourceOptions,
} from "../lib/core-install.ts";
import { buildPaths } from "../lib/paths.ts";
import { CORE_REF, CORE_REPO, type SourceRevision } from "../lib/release.ts";

const COMMIT = "9e593b74486a79b6117c1ffd5bcdc7e9ec3881b4";
const RELEASE_TAG = "v7.2.127";

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-install-"));
  const paths = buildPaths(join(dir, "data"));
  mkdirSync(paths.coreDir, { recursive: true });

  const archiveSrc = join(dir, "src");
  const rootName = `CLIProxyAPI-${COMMIT}`;
  const sourceRoot = join(archiveSrc, rootName);
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "go.mod"), "module example.invalid/CLIProxyAPI\n");
  writeFileSync(join(sourceRoot, "README.md"), "source fixture\n");
  const archivePath = join(dir, "source.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", archiveSrc, rootName]);

  const archiveBytes = readFileSync(archivePath);
  // Installs always carry a resolved ref: the "latest" sentinel has already
  // become a release tag by the time a revision exists.
  const revision: SourceRevision = {
    repo: CORE_REPO,
    ref: RELEASE_TAG,
    commit: COMMIT,
    version: `${RELEASE_TAG}@${COMMIT.slice(0, 12)}`,
    archiveUrl: `https://example.com/${COMMIT}.tar.gz`,
    binary: null,
  };

  const fetchImpl: typeof fetch = (input) =>
    String(input) === revision.archiveUrl
      ? Promise.resolve(new Response(new Uint8Array(archiveBytes)))
      : Promise.resolve(new Response("not found", { status: 404 }));

  const buildSource = async (options: BuildSourceOptions): Promise<void> => {
    assert.equal(readFileSync(join(options.sourceDir, "go.mod"), "utf8"), "module example.invalid/CLIProxyAPI\n");
    assert.equal(options.revision, revision);
    writeFileSync(options.outputPath, `#!/bin/sh\necho fake CLIProxyAPI ${revision.version}\n`);
  };

  return { dir, paths, revision, archiveBytes, fetchImpl, buildSource };
}

/** A published-release install: one root executable in the archive, verified
    against the release's checksums.txt. */
function makeBinaryFixture(corrupt = false) {
  const dir = mkdtempSync(join(tmpdir(), "agent-proxy-binary-"));
  const paths = buildPaths(join(dir, "data"));
  mkdirSync(paths.coreDir, { recursive: true });

  const assetName = `CLIProxyAPI_7.2.127_${process.platform}_aarch64.tar.gz`;
  const archiveSrc = join(dir, "asset");
  mkdirSync(archiveSrc, { recursive: true });
  const executable = basename(paths.binPath);
  writeFileSync(join(archiveSrc, executable), `#!/bin/sh\necho published CLIProxyAPI\n`);
  const archivePath = join(dir, assetName);
  execFileSync("tar", ["-czf", archivePath, "-C", archiveSrc, executable]);
  const archiveBytes = readFileSync(archivePath);
  const digest = createHash("sha256").update(archiveBytes).digest("hex");
  const checksums = `${corrupt ? "b".repeat(64) : digest}  ${assetName}\n`;

  const binary = {
    assetName,
    assetUrl: "https://example.invalid/asset.tar.gz",
    checksumsUrl: "https://example.invalid/checksums.txt",
  };
  const revision: SourceRevision = {
    repo: CORE_REPO,
    ref: RELEASE_TAG,
    commit: COMMIT,
    version: `${RELEASE_TAG}@${COMMIT.slice(0, 12)}`,
    archiveUrl: `https://example.com/${COMMIT}.tar.gz`,
    binary,
  };

  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    if (url === binary.assetUrl) return Promise.resolve(new Response(new Uint8Array(archiveBytes)));
    if (url === binary.checksumsUrl) return Promise.resolve(new Response(checksums));
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  return { paths, revision, fetchImpl };
}

function seedInstalled(
  paths: ReturnType<typeof buildPaths>,
  version: string,
  content = "old-binary",
): void {
  const releaseDir = join(paths.versionsDir, `seed-${version}`);
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, basename(paths.binPath)), content);
  writeFileSync(join(releaseDir, ".version"), `${version}\n`);
  mkdirSync(paths.binDir, { recursive: true });
  symlinkSync(releaseDir, paths.currentLink, "dir");
}

function releaseFetch(assets: { name: string; browser_download_url: string }[]): {
  fetchImpl: typeof fetch;
  requested: string[];
} {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    requested.push(url);
    const body = url.includes("/releases/")
      ? JSON.stringify({ tag_name: RELEASE_TAG, assets })
      : JSON.stringify({ sha: COMMIT });
    return Promise.resolve(new Response(body, { headers: { "content-type": "application/json" } }));
  };
  return { fetchImpl, requested };
}

test("fetchSourceRevision resolves the latest sentinel to a release archive", async () => {
  const assetName = `CLIProxyAPI_7.2.127_${process.platform}_${process.arch === "arm64" ? "aarch64" : "amd64"}.tar.gz`;
  const { fetchImpl, requested } = releaseFetch([
    { name: assetName, browser_download_url: "https://example.invalid/asset" },
    { name: "checksums.txt", browser_download_url: "https://example.invalid/checksums" },
  ]);
  const revision = await fetchSourceRevision({ repo: CORE_REPO, ref: CORE_REF }, fetchImpl);
  assert.deepEqual(requested, [
    `https://api.github.com/repos/${CORE_REPO}/releases/latest`,
    `https://api.github.com/repos/${CORE_REPO}/commits/${RELEASE_TAG}`,
  ]);
  assert.equal(revision.ref, RELEASE_TAG);
  assert.equal(revision.version, `${RELEASE_TAG}@${COMMIT.slice(0, 12)}`);
  assert.deepEqual(revision.binary, {
    assetName,
    assetUrl: "https://example.invalid/asset",
    checksumsUrl: "https://example.invalid/checksums",
  });
});

test("a release without a usable archive still resolves, for a source build", async () => {
  const { fetchImpl } = releaseFetch([
    { name: "checksums.txt", browser_download_url: "https://example.invalid/checksums" },
  ]);
  const revision = await fetchSourceRevision({ repo: CORE_REPO, ref: RELEASE_TAG }, fetchImpl);
  assert.equal(revision.binary, null);
  assert.equal(revision.commit, COMMIT);
});

test("a branch ref falls back to source when no release carries that tag", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    const url = String(input);
    requested.push(url);
    return Promise.resolve(
      url.includes("/releases/tags/")
        ? new Response("not found", { status: 404 })
        : new Response(JSON.stringify({ sha: COMMIT }), {
            headers: { "content-type": "application/json" },
          }),
    );
  };
  const revision = await fetchSourceRevision({ repo: CORE_REPO, ref: "main" }, fetchImpl);
  assert.deepEqual(requested, [
    `https://api.github.com/repos/${CORE_REPO}/releases/tags/main`,
    `https://api.github.com/repos/${CORE_REPO}/commits/main`,
  ]);
  assert.equal(revision.binary, null);
});

test("a commit ref skips the release lookup entirely", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = (input) => {
    requested.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ sha: COMMIT }), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const revision = await fetchSourceRevision({ repo: CORE_REPO, ref: COMMIT }, fetchImpl);
  assert.deepEqual(requested, [`https://api.github.com/repos/${CORE_REPO}/commits/${COMMIT}`]);
  assert.equal(revision.binary, null);
});

test("installCore publishes a verified release archive without building", async () => {
  const { paths, revision, fetchImpl } = makeBinaryFixture();
  const stages: string[] = [];
  const version = await installCore(paths, revision, {
    fetchImpl,
    onProgress: (stage) => stages.push(stage),
    buildSource: async () => assert.fail("a published archive must not trigger a build"),
  });
  assert.equal(version, revision.version);
  assert.equal(installedVersion(paths), revision.version);
  assert.match(readFileSync(paths.binPath, "utf8"), /published CLIProxyAPI/);
  assert.deepEqual(stages, ["downloading", "verifying", "extracting", "installing", "done"]);
});

test("installCore refuses a release archive that fails its checksum", async () => {
  const { paths, revision, fetchImpl } = makeBinaryFixture(true);
  seedInstalled(paths, "v7.2.126@000000000000");
  await assert.rejects(installCore(paths, revision, { fetchImpl }), /checksum mismatch/);
  assert.equal(installedVersion(paths), "v7.2.126@000000000000");
  assert.equal(readFileSync(paths.binPath, "utf8"), "old-binary");
});

test("fetchSourceRevision reports a repository with no published release", async () => {
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response("missing", { status: 404 }));
  await assert.rejects(
    fetchSourceRevision({ repo: "owner/repo", ref: "latest" }, fetchImpl),
    /owner\/repo has no published release/,
  );
});

test("fetchSourceRevision reports a missing ref", async () => {
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response("missing", { status: 404 }));
  await assert.rejects(
    fetchSourceRevision({ repo: "owner/repo", ref: "missing" }, fetchImpl),
    /source owner\/repo#missing not found/,
  );
});

test("installCore downloads, validates, builds, and lands atomically", async () => {
  const { paths, revision, fetchImpl, buildSource } = makeFixture();
  const stages: string[] = [];
  const version = await installCore(paths, revision, {
    fetchImpl,
    buildSource,
    onProgress: (stage) => stages.push(stage),
    beforeInstall: async () => {
      stages.push("swap");
    },
  });
  assert.equal(version, revision.version);
  assert.deepEqual(stages, ["downloading", "verifying", "extracting", "building", "installing", "swap", "done"]);
  assert.equal(installedVersion(paths), revision.version);
  assert.ok(existsSync(paths.binPath));
  const mode = (await import("node:fs")).statSync(paths.binPath).mode & 0o777;
  assert.equal(mode, 0o755);
  const leftovers = (await import("node:fs"))
    .readdirSync(paths.coreDir)
    .filter((entry) => entry.startsWith("tmp-"));
  assert.deepEqual(leftovers, []);
});

test("successful update atomically switches binary and revision together", async () => {
  const { paths, revision, fetchImpl, buildSource } = makeFixture();
  seedInstalled(paths, "7.2.127");
  await installCore(paths, revision, { fetchImpl, buildSource });
  assert.equal(installedVersion(paths), revision.version);
  assert.match(readFileSync(paths.binPath, "utf8"), new RegExp(`${RELEASE_TAG}@`));
});

test("build failure leaves the previous binary active", async () => {
  const { paths, revision, fetchImpl } = makeFixture();
  seedInstalled(paths, "7.2.127");

  await assert.rejects(
    installCore(paths, revision, {
      fetchImpl,
      buildSource: async () => {
        throw new Error("compiler failed");
      },
    }),
    /compiler failed/,
  );
  assert.equal(readFileSync(paths.binPath, "utf8"), "old-binary");
  assert.equal(installedVersion(paths), "7.2.127");
});

test("archive links are rejected before extraction", async () => {
  const { dir, paths, revision, buildSource } = makeFixture();
  const archiveSrc = join(dir, "unsafe-src");
  const root = join(archiveSrc, "CLIProxyAPI-unsafe");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "go.mod"), "module example.invalid/unsafe\n");
  symlinkSync("/tmp/not-source", join(root, "redirect"));
  const archivePath = join(dir, "unsafe.tar.gz");
  execFileSync("tar", ["-czf", archivePath, "-C", archiveSrc, "CLIProxyAPI-unsafe"]);
  const archiveBytes = readFileSync(archivePath);
  const fetchImpl: typeof fetch = () => Promise.resolve(new Response(new Uint8Array(archiveBytes)));

  await assert.rejects(installCore(paths, revision, { fetchImpl, buildSource }), /unsafe link entry/);
  assert.equal(existsSync(paths.binPath), false);
  rmSync(archiveSrc, { recursive: true, force: true });
});

test("abort cancels an in-flight source download", async () => {
  const { paths, revision, buildSource } = makeFixture();
  const controller = new AbortController();
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  const installing = installCore(paths, revision, {
    fetchImpl,
    buildSource,
    signal: controller.signal,
  });
  controller.abort(new Error("disposed"));
  await assert.rejects(installing, /disposed/);
});

test("installedVersion requires the binary, not just the marker", () => {
  const { paths } = makeFixture();
  const releaseDir = join(paths.versionsDir, "marker-only");
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(join(releaseDir, ".version"), "missing-binary\n");
  mkdirSync(paths.binDir, { recursive: true });
  symlinkSync(releaseDir, paths.currentLink, "dir");
  assert.equal(installedVersion(paths), null);
});

test("migrateLegacyInstall publishes a complete pointer without deleting the legacy install", () => {
  const { paths } = makeFixture();
  mkdirSync(paths.binDir, { recursive: true });
  writeFileSync(paths.legacyBinPath, "legacy-binary");
  writeFileSync(paths.legacyVersionMarker, "7.0.0\n");
  migrateLegacyInstall(paths);
  assert.equal(installedVersion(paths), "7.0.0");
  assert.equal(readFileSync(paths.binPath, "utf8"), "legacy-binary");
  assert.equal(readFileSync(paths.legacyBinPath, "utf8"), "legacy-binary");
});

test("cleanStaleStaging removes only tmp dirs", () => {
  const { paths } = makeFixture();
  mkdirSync(join(paths.coreDir, "tmp-123"), { recursive: true });
  mkdirSync(join(paths.coreDir, "auth"), { recursive: true });
  cleanStaleStaging(paths.coreDir);
  assert.equal(existsSync(join(paths.coreDir, "tmp-123")), false);
  assert.equal(existsSync(join(paths.coreDir, "auth")), true);
});
