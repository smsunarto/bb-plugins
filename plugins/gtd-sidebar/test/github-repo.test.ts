import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { githubPullUrl, parseGithubRemote, parsePrRefFromTitle } from "../lib/github-repo.ts";

describe("parseGithubRemote", () => {
  it("reads https, ssh, and git@ remotes", () => {
    assert.deepEqual(parseGithubRemote("https://github.com/acme/app.git"), {
      owner: "acme",
      repo: "app",
    });
    assert.deepEqual(parseGithubRemote("git@github.com:acme/app.git"), {
      owner: "acme",
      repo: "app",
    });
    assert.deepEqual(parseGithubRemote("ssh://git@github.com/acme/app"), {
      owner: "acme",
      repo: "app",
    });
  });

  it("rejects non-github remotes", () => {
    assert.equal(parseGithubRemote("https://gitlab.com/acme/app.git"), null);
  });
});

describe("parsePrRefFromTitle", () => {
  it("reads owner/repo#number from a title", () => {
    assert.deepEqual(parsePrRefFromTitle("ai-ecoverse/slicc#2406: Feature: curl"), {
      owner: "ai-ecoverse",
      repo: "slicc",
      number: 2406,
    });
  });

  it("reads a bare #number", () => {
    assert.deepEqual(parsePrRefFromTitle("Verify APNs push on staging (#2213 for iOS)"), {
      owner: null,
      repo: null,
      number: 2213,
    });
  });

  it("returns null when there is no PR number", () => {
    assert.equal(parsePrRefFromTitle("Investigate issue 388"), null);
  });
});

describe("githubPullUrl", () => {
  it("builds a canonical html URL", () => {
    assert.equal(githubPullUrl("acme", "app", 12), "https://github.com/acme/app/pull/12");
  });
});
