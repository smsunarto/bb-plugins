import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitApiUrl,
  DEFAULT_CORE_SOURCE,
  CORE_REF,
  CORE_REPO,
  normalizeCoreRef,
  normalizeCoreRepo,
  normalizeCoreSource,
  parseSourceRevision,
  sourceArchiveUrl,
  sourceVersion,
} from "../lib/release.ts";

const COMMIT = "9e593b74486a79b6117c1ffd5bcdc7e9ec3881b4";

test("source constants target the advisor fix branch", () => {
  assert.equal(CORE_REPO, "smsunarto/CLIProxyAPI");
  assert.equal(CORE_REF, "fix/claude-advisor-server-tool");
  assert.deepEqual(DEFAULT_CORE_SOURCE, { repo: CORE_REPO, ref: CORE_REF });
});

test("commitApiUrl safely encodes branch names", () => {
  assert.equal(
    commitApiUrl(),
    "https://api.github.com/repos/smsunarto/CLIProxyAPI/commits/fix%2Fclaude-advisor-server-tool",
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
  assert.equal(normalizeCoreRef(" fix/claude-advisor-server-tool "), CORE_REF);
  assert.equal(normalizeCoreRef(COMMIT), COMMIT);
  for (const invalid of ["", "feature branch", "../main", "main..next", "topic@{1}", ".hidden"]) {
    assert.throws(() => normalizeCoreRef(invalid), /branch or ref/);
  }
  assert.deepEqual(normalizeCoreSource("smsunarto/CLIProxyAPI", CORE_REF), {
    repo: CORE_REPO,
    ref: CORE_REF,
  });
});

test("source revision is pinned to the resolved commit", () => {
  const revision = parseSourceRevision({ sha: COMMIT.toUpperCase() });
  assert.deepEqual(revision, {
    repo: CORE_REPO,
    ref: CORE_REF,
    commit: COMMIT,
    version: `${CORE_REF}@9e593b74486a`,
    archiveUrl: `https://codeload.github.com/${CORE_REPO}/tar.gz/${COMMIT}`,
  });
  assert.equal(sourceVersion(CORE_REF, COMMIT), `${CORE_REF}@9e593b74486a`);
  assert.equal(sourceArchiveUrl(CORE_REPO, COMMIT), revision.archiveUrl);
});

test("parseSourceRevision rejects malformed responses", () => {
  assert.throws(() => parseSourceRevision(null), /malformed/);
  assert.throws(() => parseSourceRevision({}), /valid sha/);
  assert.throws(() => parseSourceRevision({ sha: "not-a-commit" }), /valid sha/);
});
