import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
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
  const revision: SourceRevision = {
    repo: CORE_REPO,
    ref: CORE_REF,
    commit: COMMIT,
    version: `${CORE_REF}@${COMMIT.slice(0, 12)}`,
    archiveUrl: `https://example.com/${COMMIT}.tar.gz`,
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

test("fetchSourceRevision resolves the configured ref to an immutable commit", async () => {
  let requested = "";
  const fetchImpl: typeof fetch = (input) => {
    requested = String(input);
    return Promise.resolve(
      new Response(JSON.stringify({ sha: COMMIT }), {
        headers: { "content-type": "application/json" },
      }),
    );
  };
  const revision = await fetchSourceRevision({ repo: CORE_REPO, ref: CORE_REF }, fetchImpl);
  assert.match(requested, /commits\/fix%2Fclaude-advisor-server-tool$/);
  assert.equal(revision.commit, COMMIT);
  assert.equal(revision.version, `${CORE_REF}@${COMMIT.slice(0, 12)}`);
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
  assert.match(readFileSync(paths.binPath, "utf8"), /claude-advisor-server-tool/);
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
