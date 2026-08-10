import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitApiUrl,
  DEFAULT_CORE_SOURCE,
  CORE_REF,
  CORE_REPO,
  isLatestReleaseRef,
  latestReleaseApiUrl,
  LATEST_RELEASE_REF,
  normalizeCoreRef,
  normalizeCoreRepo,
  normalizeCoreSource,
  parseChecksums,
  parseRelease,
  parseSourceRevision,
  pickReleaseBinary,
  releaseAssetName,
  releaseTagApiUrl,
  sourceArchiveUrl,
  sourceVersion,
} from "../lib/release.ts";

const COMMIT = "9e593b74486a79b6117c1ffd5bcdc7e9ec3881b4";

test("source constants target the upstream latest release", () => {
  assert.equal(CORE_REPO, "router-for-me/CLIProxyAPI");
  assert.equal(CORE_REF, LATEST_RELEASE_REF);
  assert.deepEqual(DEFAULT_CORE_SOURCE, { repo: CORE_REPO, ref: CORE_REF });
});

test("the latest sentinel is recognized whatever the case", () => {
  for (const ref of ["latest", "Latest", " LATEST "]) {
    assert.equal(isLatestReleaseRef(ref), true);
  }
  for (const ref of ["main", "v7.2.127", "latest-stable"]) {
    assert.equal(isLatestReleaseRef(ref), false);
  }
  assert.equal(
    latestReleaseApiUrl(CORE_REPO),
    "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/latest",
  );
});

test("parseRelease reads the tag and the downloadable assets", () => {
  const release = parseRelease({
    tag_name: " v7.2.127 ",
    assets: [
      { name: "checksums.txt", browser_download_url: "https://example.invalid/checksums.txt" },
      { name: "ignored", size: 1 },
      { name: "CLIProxyAPI_7.2.127_darwin_aarch64.tar.gz", browser_download_url: "https://example.invalid/a" },
    ],
  });
  assert.equal(release.tag, "v7.2.127");
  assert.deepEqual(
    release.assets.map((asset) => asset.name),
    ["checksums.txt", "CLIProxyAPI_7.2.127_darwin_aarch64.tar.gz"],
  );
  assert.throws(() => parseRelease(null), /malformed/);
  assert.throws(() => parseRelease({}), /tag_name/);
  assert.throws(() => parseRelease({ tag_name: "   " }), /tag_name/);
  assert.throws(() => parseRelease({ tag_name: "bad ref" }), /branch or ref/);
  assert.equal(
    releaseTagApiUrl(CORE_REPO, "v7.2.127"),
    "https://api.github.com/repos/router-for-me/CLIProxyAPI/releases/tags/v7.2.127",
  );
});

test("release assets are named per platform, with source as the fallback", () => {
  assert.equal(releaseAssetName("v7.2.127", "darwin", "arm64"), "CLIProxyAPI_7.2.127_darwin_aarch64.tar.gz");
  assert.equal(releaseAssetName("7.2.127", "linux", "x64"), "CLIProxyAPI_7.2.127_linux_amd64.tar.gz");
  assert.equal(releaseAssetName("7.2.127", "win32", "x64"), null);
  assert.equal(releaseAssetName("7.2.127", "linux", "ppc64"), null);

  const assets = [
    { name: "CLIProxyAPI_7.2.127_darwin_aarch64.tar.gz", url: "https://example.invalid/a" },
    { name: "checksums.txt", url: "https://example.invalid/c" },
  ];
  assert.deepEqual(pickReleaseBinary({ tag: "v7.2.127", assets }, "darwin", "arm64"), {
    assetName: "CLIProxyAPI_7.2.127_darwin_aarch64.tar.gz",
    assetUrl: "https://example.invalid/a",
    checksumsUrl: "https://example.invalid/c",
  });
  // No archive for the platform, and no checksums.txt: both build from source.
  assert.equal(pickReleaseBinary({ tag: "v7.2.127", assets }, "linux", "x64"), null);
  assert.equal(pickReleaseBinary({ tag: "v7.2.127", assets: [assets[0]!] }, "darwin", "arm64"), null);
});

test("parseChecksums reads sha256 lines", () => {
  const sha = "a".repeat(64);
  const map = parseChecksums(`${sha}  CLIProxyAPI_7.2.127_darwin_aarch64.tar.gz\nnonsense\n`);
  assert.equal(map.get("CLIProxyAPI_7.2.127_darwin_aarch64.tar.gz"), sha);
  assert.equal(map.size, 1);
});

test("commitApiUrl safely encodes branch names", () => {
  assert.equal(
    commitApiUrl(),
    "https://api.github.com/repos/router-for-me/CLIProxyAPI/commits/latest",
  );
  assert.equal(
    commitApiUrl({ repo: "router-for-me/CLIProxyAPI", ref: "feature/a b" }),
    "https://api.github.com/repos/router-for-me/CLIProxyAPI/commits/feature%2Fa%20b",
  );
});

test("repository settings normalize supported GitHub source forms", () => {
  assert.equal(normalizeCoreRepo(" router-for-me/CLIProxyAPI "), "router-for-me/CLIProxyAPI");
  assert.equal(
    normalizeCoreRepo("https://github.com/smsunarto/CLIProxyAPI.git"),
    "smsunarto/CLIProxyAPI",
  );
  assert.equal(
    normalizeCoreRepo("git@github.com:smsunarto/CLIProxyAPI.git"),
    "smsunarto/CLIProxyAPI",
  );
  assert.throws(() => normalizeCoreRepo("https://example.com/owner/repo"), /github\.com/);
  assert.throws(() => normalizeCoreRepo("owner/repo/extra"), /owner\/name/);
});

test("branch settings accept Git refs and reject unsafe names", () => {
  assert.equal(normalizeCoreRef(" fix/claude-advisor-server-tool "), "fix/claude-advisor-server-tool");
  assert.equal(normalizeCoreRef(COMMIT), COMMIT);
  for (const invalid of ["", "feature branch", "../main", "main..next", "topic@{1}", ".hidden"]) {
    assert.throws(() => normalizeCoreRef(invalid), /branch or ref/);
  }
  assert.deepEqual(normalizeCoreSource("router-for-me/CLIProxyAPI", CORE_REF), {
    repo: CORE_REPO,
    ref: CORE_REF,
  });
});

test("source revision is pinned to the resolved commit", () => {
  // The install pipeline resolves "latest" to a release tag before this call,
  // so the version names the release rather than the sentinel.
  const source = { repo: CORE_REPO, ref: "v7.2.127" };
  const revision = parseSourceRevision({ sha: COMMIT.toUpperCase() }, source);
  assert.deepEqual(revision, {
    repo: CORE_REPO,
    ref: "v7.2.127",
    commit: COMMIT,
    version: "v7.2.127@9e593b74486a",
    archiveUrl: `https://codeload.github.com/${CORE_REPO}/tar.gz/${COMMIT}`,
    binary: null,
  });
  assert.equal(sourceVersion("v7.2.127", COMMIT), "v7.2.127@9e593b74486a");
  assert.equal(sourceArchiveUrl(CORE_REPO, COMMIT), revision.archiveUrl);
});

test("parseSourceRevision rejects malformed responses", () => {
  assert.throws(() => parseSourceRevision(null), /malformed/);
  assert.throws(() => parseSourceRevision({}), /valid sha/);
  assert.throws(() => parseSourceRevision({ sha: "not-a-commit" }), /valid sha/);
});
