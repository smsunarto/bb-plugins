import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  dedicatedGithubWebhookUrl,
  eventsMatch,
  githubWebhookUrl,
  isSessionGatedWebhookOrigin,
  isTrycloudflareWebhookUrl,
  matchingGithubHook,
  matchingManagedGithubHook,
  parseWebhookPull,
  resolveWebhookDeliveryUrl,
  shouldStartCloudflareTunnel,
  verifyGithubSignature,
  webhookPrNumbers,
} from "../lib/github-webhook.ts";

describe("githubWebhookUrl", () => {
  it("joins the connect origin to the plugin HTTP path", () => {
    assert.equal(
      githubWebhookUrl("https://lars.getbb.app/", "gtd-sidebar"),
      "https://lars.getbb.app/api/v1/plugins/gtd-sidebar/http/github-webhook",
    );
  });
});

describe("dedicatedGithubWebhookUrl", () => {
  it("uses the webhook-only path on a trycloudflare origin", () => {
    assert.equal(
      dedicatedGithubWebhookUrl("https://random-words.trycloudflare.com/"),
      "https://random-words.trycloudflare.com/github-webhook",
    );
  });
});

describe("resolveWebhookDeliveryUrl", () => {
  it("prefers a real public origin, skips getbb.app, then uses the tunnel", () => {
    assert.equal(
      resolveWebhookDeliveryUrl({
        configuredOrigin: "https://hooks.example.com",
        tunnelOrigin: "https://random-words.trycloudflare.com",
        pluginId: "gtd-sidebar",
      }),
      "https://hooks.example.com/api/v1/plugins/gtd-sidebar/http/github-webhook",
    );
    assert.equal(
      resolveWebhookDeliveryUrl({
        configuredOrigin: "https://lars.getbb.app",
        tunnelOrigin: "https://random-words.trycloudflare.com",
        pluginId: "gtd-sidebar",
      }),
      "https://random-words.trycloudflare.com/github-webhook",
    );
    assert.equal(
      resolveWebhookDeliveryUrl({
        configuredOrigin: "",
        tunnelOrigin: null,
        pluginId: "gtd-sidebar",
      }),
      null,
    );
  });
});

describe("shouldStartCloudflareTunnel", () => {
  it("starts only when enabled and no usable manual origin is set", () => {
    assert.equal(shouldStartCloudflareTunnel(false, ""), false);
    assert.equal(shouldStartCloudflareTunnel(true, ""), true);
    assert.equal(shouldStartCloudflareTunnel(true, "https://lars.getbb.app"), true);
    assert.equal(shouldStartCloudflareTunnel(true, "https://hooks.example.com"), false);
  });
});

describe("isSessionGatedWebhookOrigin", () => {
  it("rejects bb connect hosts, which require a sign-in session", () => {
    assert.equal(isSessionGatedWebhookOrigin("https://lars.getbb.app"), true);
    assert.equal(isSessionGatedWebhookOrigin("https://lars--5717.getbb.app"), true);
    assert.equal(isSessionGatedWebhookOrigin("https://example.com"), false);
    assert.equal(
      isSessionGatedWebhookOrigin("https://random-words.trycloudflare.com"),
      false,
    );
  });
});

describe("verifyGithubSignature", () => {
  it("accepts a matching sha256 HMAC and rejects a bad one", () => {
    const secret = "s3cret";
    const body = '{"ok":true}';
    const header = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    assert.equal(verifyGithubSignature(secret, body, header), true);
    assert.equal(verifyGithubSignature(secret, body, "sha256=deadbeef"), false);
    assert.equal(verifyGithubSignature(secret, body, undefined), false);
  });
});

describe("parseWebhookPull", () => {
  it("reads a pull_request event payload", () => {
    const parsed = parseWebhookPull({
      repository: { name: "slicc", owner: { login: "ai-ecoverse" } },
      pull_request: {
        number: 2423,
        title: "refresh files panel",
        html_url: "https://github.com/ai-ecoverse/slicc/pull/2423",
        state: "open",
        draft: false,
        merged: false,
        mergeable_state: "clean",
        auto_merge: null,
        head: { ref: "feat/files" },
      },
    });
    assert.equal(parsed?.owner, "ai-ecoverse");
    assert.equal(parsed?.repo, "slicc");
    assert.equal(parsed?.pull.number, 2423);
    assert.equal(parsed?.pull.mergeableState, "clean");
  });
});

describe("webhookPrNumbers", () => {
  it("reads check_suite pull_requests", () => {
    const numbers = webhookPrNumbers("check_suite", {
      check_suite: { pull_requests: [{ number: 12 }, { number: 13 }] },
    });
    assert.deepEqual(numbers, [12, 13]);
  });
});

describe("matchingGithubHook", () => {
  it("finds the hook with our URL", () => {
    const url = "https://lars.getbb.app/api/v1/plugins/gtd-sidebar/http/github-webhook";
    const found = matchingGithubHook(
      [
        { id: 1, config: { url: "https://example.com" }, events: ["push"] },
        { id: 9, config: { url }, events: ["pull_request"] },
      ],
      url,
    );
    assert.deepEqual(found, { id: 9, events: ["pull_request"], url });
    assert.equal(eventsMatch(["pull_request"], ["pull_request", "check_suite"]), false);
    assert.equal(eventsMatch(["a", "b"], ["b", "a"]), true);
  });

  it("reuses a previous trycloudflare hook after the URL rotates", () => {
    const previous = "https://old-words.trycloudflare.com/github-webhook";
    const next = "https://new-words.trycloudflare.com/github-webhook";
    const found = matchingManagedGithubHook(
      [{ id: 3, config: { url: previous }, events: ["pull_request"] }],
      next,
      previous,
    );
    assert.deepEqual(found, { id: 3, events: ["pull_request"], url: previous });
    assert.equal(isTrycloudflareWebhookUrl(previous), true);
    assert.equal(isTrycloudflareWebhookUrl(next), true);
  });

  it("does not claim an unrelated trycloudflare hook", () => {
    const found = matchingManagedGithubHook(
      [
        {
          id: 8,
          config: { url: "https://someone-else.trycloudflare.com/github-webhook" },
          events: ["pull_request"],
        },
      ],
      "https://ours.trycloudflare.com/github-webhook",
    );
    assert.equal(found, null);
  });
});
