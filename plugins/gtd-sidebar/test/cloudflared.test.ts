import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  parseTrycloudflareOrigin,
  resolveCloudflaredPath,
  startTrycloudflareTunnel,
} from "../lib/cloudflared.ts";
import { startWebhookListener } from "../lib/webhook-listener.ts";
import { maintainCloudflareWebhookTunnel } from "../lib/github-webhook-tunnel.ts";
import { createHmac } from "node:crypto";
import { verifyGithubSignature } from "../lib/github-webhook.ts";

describe("parseTrycloudflareOrigin", () => {
  it("pulls the first trycloudflare URL out of cloudflared logs", () => {
    const log = [
      "INF Requesting new quick Tunnel on trycloudflare.com...",
      "INF |  Your quick Tunnel has been created! Visit it at:",
      "INF |  https://random-words-here.trycloudflare.com                                               |",
    ].join("\n");
    assert.equal(parseTrycloudflareOrigin(log), "https://random-words-here.trycloudflare.com");
    assert.equal(parseTrycloudflareOrigin("no url here"), null);
  });
});

describe("resolveCloudflaredPath", () => {
  it("returns the first candidate whose --version succeeds", async () => {
    const tried: string[] = [];
    const path = await resolveCloudflaredPath(new AbortController().signal, async (file) => {
      tried.push(file);
      return { exitCode: file === "/opt/homebrew/bin/cloudflared" ? 0 : 1 };
    });
    assert.equal(path, "/opt/homebrew/bin/cloudflared");
    assert.deepEqual(tried, ["cloudflared", "/opt/homebrew/bin/cloudflared"]);
  });

  it("returns null when nothing on PATH answers", async () => {
    const path = await resolveCloudflaredPath(new AbortController().signal, async () => ({
      exitCode: 1,
    }));
    assert.equal(path, null);
  });
});

describe("startWebhookListener", () => {
  it("accepts a signed POST on /github-webhook and 404s other paths", async () => {
    const secret = "s3cret";
    const body = '{"zen":"ok"}';
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const listener = await startWebhookListener({
      handle: async (input) => {
        if (!verifyGithubSignature(secret, input.raw, input.signature)) {
          return { status: 401, body: { ok: false } };
        }
        return { status: 200, body: { ok: true, event: input.event } };
      },
    });
    try {
      const missed = await fetch(`http://127.0.0.1:${listener.port}/`);
      assert.equal(missed.status, 404);
      const health = await fetch(`http://127.0.0.1:${listener.port}/github-webhook`);
      assert.equal(health.status, 200);
      const posted = await fetch(`http://127.0.0.1:${listener.port}/github-webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "ping",
          "x-hub-signature-256": signature,
        },
        body,
      });
      assert.equal(posted.status, 200);
      assert.deepEqual(await posted.json(), { ok: true, event: "ping" });
    } finally {
      await listener.close();
    }
  });
});

describe("startTrycloudflareTunnel", () => {
  it("resolves the origin printed on stderr and stops the child", async () => {
    const run = new AbortController();
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter & { setEncoding: (enc: string) => void };
      stderr: EventEmitter & { setEncoding: (enc: string) => void };
      kill: (signal?: string) => boolean;
      exitCode: number | null;
      signalCode: string | null;
    };
    child.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    };
    const pending = startTrycloudflareTunnel({
      bin: "cloudflared",
      localOrigin: "http://127.0.0.1:9",
      signal: run.signal,
      timeoutMs: 1_000,
      spawnImpl: () => {
        setImmediate(() => {
          child.stderr.emit(
            "data",
            "INF |  https://unit-test.trycloudflare.com                                               |\n",
          );
        });
        return child as never;
      },
    });
    const tunnel = await pending;
    assert.equal(tunnel.origin, "https://unit-test.trycloudflare.com");
    tunnel.stop();
    assert.equal(await tunnel.wait, 0);
  });
});

describe("maintainCloudflareWebhookTunnel", () => {
  it("reports missing-cloudflared when the binary is absent", async () => {
    const run = new AbortController();
    const statuses: string[] = [];
    const done = maintainCloudflareWebhookTunnel({
      signal: run.signal,
      readSettings: async () => ({ enabled: true, configuredOrigin: "" }),
      onSettingsChange: () => () => undefined,
      handle: async () => ({ status: 200, body: { ok: true } }),
      onLive: () => {
        throw new Error("should not go live");
      },
      onStopped: () => undefined,
      onStatus: (status) => {
        statuses.push(status.state);
        if (status.state === "missing-cloudflared") run.abort();
      },
      log: { info: () => undefined, warn: () => undefined },
      resolveBin: async () => null,
    });
    await done;
    assert.ok(statuses.includes("checking"));
    assert.ok(statuses.includes("missing-cloudflared"));
  });

  it("backs off when cloudflared exits after going live", async () => {
    const run = new AbortController();
    const liveAt: number[] = [];
    const statuses: string[] = [];
    const done = maintainCloudflareWebhookTunnel({
      signal: run.signal,
      readSettings: async () => ({ enabled: true, configuredOrigin: "" }),
      onSettingsChange: () => () => undefined,
      handle: async () => ({ status: 200, body: { ok: true } }),
      onLive: () => {
        liveAt.push(Date.now());
        if (liveAt.length >= 2) run.abort();
      },
      onStopped: () => undefined,
      onStatus: (status) => {
        statuses.push(status.state);
      },
      log: { info: () => undefined, warn: () => undefined },
      resolveBin: async () => "/opt/homebrew/bin/cloudflared",
      startListener: async () => ({ port: 9, close: async () => undefined }),
      startTunnel: async () => ({
        origin: "https://unit-test.trycloudflare.com",
        wait: Promise.resolve(1),
        stop: () => undefined,
      }),
      retryDelayMs: 50,
    });
    await done;
    assert.ok(statuses.includes("live"));
    assert.ok(statuses.includes("error"));
    assert.equal(liveAt.length, 2);
    assert.ok(liveAt[1]! - liveAt[0]! >= 40);
  });
});
