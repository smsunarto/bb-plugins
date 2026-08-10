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
  parseLatestReleaseTag,
  parseSourceRevision,
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

test("parseLatestReleaseTag reads and validates the release tag", () => {
  assert.equal(parseLatestReleaseTag({ tag_name: " v7.2.127 " }), "v7.2.127");
  assert.throws(() => parseLatestReleaseTag(null), /malformed/);
  assert.throws(() => parseLatestReleaseTag({}), /tag_name/);
  assert.throws(() => parseLatestReleaseTag({ tag_name: "   " }), /tag_name/);
  assert.throws(() => parseLatestReleaseTag({ tag_name: "bad ref" }), /branch or ref/);
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
  });
  assert.equal(sourceVersion("v7.2.127", COMMIT), "v7.2.127@9e593b74486a");
  assert.equal(sourceArchiveUrl(CORE_REPO, COMMIT), revision.archiveUrl);
});

test("parseSourceRevision rejects malformed responses", () => {
  assert.throws(() => parseSourceRevision(null), /malformed/);
  assert.throws(() => parseSourceRevision({}), /valid sha/);
  assert.throws(() => parseSourceRevision({ sha: "not-a-commit" }), /valid sha/);
});
