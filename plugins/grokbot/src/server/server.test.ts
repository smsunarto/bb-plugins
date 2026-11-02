import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TEXT_LENGTH } from "../shared/contract.ts";
import { CONFIG_PATH_ENV, loadConfig, publicStatus } from "./config.ts";
import { createSendLog, type KvStore } from "./send-log.ts";
import plugin from "./server.ts";
import { createGrokbotService, GrokbotRefusal } from "./service.ts";
import { postWebhook, type WebhookPayload } from "./webhook.ts";

const DUMMY_KEY = "dummy-key-not-a-secret";

interface Received {
  method: string | undefined;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** A local webhook stub: replies with `status`, or never replies when `hang`. */
function startStub(): Promise<{
  url: string;
  received: Received[];
  setStatus(status: number): void;
  setHang(hang: boolean): void;
  setLocation(location: string | null): void;
  close(): Promise<void>;
}> {
  const received: Received[] = [];
  let status = 200;
  let hang = false;
  let location: string | null = null;
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => (raw += chunk.toString("utf8")));
    request.on("end", () => {
      received.push({ method: request.method, headers: request.headers, body: JSON.parse(raw) });
      if (hang) return;
      response.writeHead(status, {
        "Content-Type": "application/json",
        ...(location ? { Location: location } : {}),
      });
      response.end('{"ok":true}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/hook?token=url-secret`,
        received,
        setStatus: (next) => (status = next),
        setHang: (next) => (hang = next),
        setLocation: (next) => (location = next),
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function memoryKv(): KvStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key, value) => void data.set(key, structuredClone(value)),
  };
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeConfig(name: string, value: unknown, mode = 0o600): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  await chmod(path, mode);
  return path;
}

describe("loadConfig", () => {
  test("reports a missing file as not configured", async () => {
    const loaded = await loadConfig(join(dir, "absent.json"));
    expect(loaded.state).toBe("missing");
  });

  test("refuses a group- or world-readable file without reading it", async () => {
    const path = await writeConfig("open.json", { url: "https://x.test", key: DUMMY_KEY }, 0o644);
    const loaded = await loadConfig(path);
    expect(loaded.state).toBe("insecure");
    expect(JSON.stringify(loaded)).toContain("chmod 600");
  });

  test("rejects bad JSON and a non-http URL without echoing values", async () => {
    expect((await loadConfig(await writeConfig("bad.json", "{nope"))).state).toBe("invalid");
    const ftp = await loadConfig(
      await writeConfig("ftp.json", { url: "ftp://secret-host.test", key: DUMMY_KEY }),
    );
    expect(ftp.state).toBe("invalid");
    expect(JSON.stringify(ftp)).not.toContain("secret-host");
    expect(JSON.stringify(ftp)).not.toContain(DUMMY_KEY);
  });

  test("rejects a key that cannot be sent as an HTTP header", async () => {
    const loaded = await loadConfig(
      await writeConfig("badkey.json", { url: "https://grok.test", key: "abc\u00e9def" }),
    );
    expect(loaded.state).toBe("invalid");
    expect(JSON.stringify(loaded)).toContain("not allowed in an HTTP header");
    expect(JSON.stringify(loaded)).not.toContain("abc");
  });

  test("rejects a URL with embedded credentials without echoing them", async () => {
    const loaded = await loadConfig(
      await writeConfig("creds.json", {
        url: "https://user:hunter2@grok.test/hook",
        key: DUMMY_KEY,
      }),
    );
    expect(loaded.state).toBe("invalid");
    expect(JSON.stringify(loaded)).toContain("must not embed credentials");
    expect(JSON.stringify(loaded)).not.toContain("hunter2");
  });

  test("names bots by id when no name is given and drops duplicates", async () => {
    const path = await writeConfig("ok.json", {
      url: "https://grok.test/hook",
      key: DUMMY_KEY,
      bots: [{ id: "a", name: "Alpha" }, { id: "b" }, { id: "a", name: "Dup" }],
    });
    const loaded = await loadConfig(path);
    expect(loaded.state).toBe("ready");
    const status = publicStatus(loaded);
    expect(status).toEqual({
      state: "ready",
      configPath: path,
      bots: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "b" },
      ],
    });
    // The browser-facing status never carries the URL or key.
    expect(JSON.stringify(status)).not.toContain(DUMMY_KEY);
    expect(JSON.stringify(status)).not.toContain("grok.test");
  });
});

describe("postWebhook against a local stub", () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(async () => {
    await stub.close();
  });

  const payload: WebhookPayload = {
    action: "ping",
    target_bot: null,
    text: "ping",
    ts: "2026-11-02T00:00:00.000Z",
  };

  test("POSTs JSON with both auth headers and reports 200", async () => {
    stub.setStatus(200);
    const outcome = await postWebhook({ url: stub.url, key: DUMMY_KEY }, payload);
    expect(outcome).toMatchObject({ ok: true, status: 200, error: null });
    const request = stub.received.at(-1);
    expect(request?.method).toBe("POST");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(request?.headers.authorization).toBe(`Bearer ${DUMMY_KEY}`);
    expect(request?.headers["x-automation-key"]).toBe(DUMMY_KEY);
    expect(request?.body).toEqual(payload);
  });

  test("reports a non-2xx status as failed after one try", async () => {
    stub.setStatus(500);
    const before = stub.received.length;
    const outcome = await postWebhook({ url: stub.url, key: DUMMY_KEY }, payload);
    expect(outcome).toMatchObject({ ok: false, status: 500, error: "HTTP 500" });
    expect(stub.received.length - before).toBe(1);
  });

  test("does not follow a redirect, so the key never reaches the second address", async () => {
    const second = await startStub();
    try {
      stub.setStatus(302);
      stub.setLocation(second.url);
      const outcome = await postWebhook({ url: stub.url, key: DUMMY_KEY }, payload);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toContain("redirect (not followed)");
      expect(second.received).toEqual([]);
    } finally {
      stub.setLocation(null);
      stub.setStatus(200);
      await second.close();
    }
  });

  test("times out without retrying and keeps the URL out of the error", async () => {
    stub.setHang(true);
    const before = stub.received.length;
    const outcome = await postWebhook({ url: stub.url, key: DUMMY_KEY }, payload, {
      timeoutMs: 150,
    });
    stub.setHang(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.error).toBe("Timed out after 0s");
    expect(stub.received.length - before).toBe(1);
  });

  test("names a refused connection by code only", async () => {
    const outcome = await postWebhook(
      { url: "http://127.0.0.1:9/hook?token=url-secret", key: DUMMY_KEY },
      payload,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/^Network error/);
    expect(outcome.error).not.toContain("url-secret");
  });
});

describe("GrokbotService", () => {
  const ready =
    (bots = [{ id: "research", name: "Research" }]) =>
    async () => ({
      state: "ready" as const,
      configPath: "/tmp/config.json",
      config: { url: "https://grok.test/hook?token=url-secret", key: DUMMY_KEY, bots },
    });
  const lookupThread = async (threadId: string) => ({
    thread_id: threadId,
    project: "bb-plugins",
    branch: "scott/grokbot",
    title: "Build grokbot",
  });

  test("sends thread context and logs the outcome without the URL or key", async () => {
    const kv = memoryKv();
    const posted: WebhookPayload[] = [];
    const service = createGrokbotService({
      loadConfig: ready(),
      lookupThread,
      log: createSendLog(kv),
      post: async (_config, payload) => {
        posted.push(payload);
        return { ok: true, status: 200, error: null, durationMs: 12 };
      },
      now: () => new Date("2026-11-02T10:00:00.000Z"),
      newId: () => "entry-1",
    });
    const { entry } = await service.send({
      action: "message",
      text: "  summarize this  ",
      targetBot: "research",
      threadId: "thr_1",
    });
    expect(posted).toEqual([
      {
        action: "message",
        target_bot: "research",
        text: "summarize this",
        context: { thread_id: "thr_1", project: "bb-plugins", branch: "scott/grokbot" },
        ts: "2026-11-02T10:00:00.000Z",
      },
    ]);
    expect(entry).toMatchObject({ id: "entry-1", ok: true, status: 200, target_bot: "research" });
    const stored = JSON.stringify([...kv.data.values()]);
    expect(stored).not.toContain(DUMMY_KEY);
    expect(stored).not.toContain("url-secret");
    expect(await service.recent()).toEqual([entry]);
  });

  test("a ping without a target sends target_bot null and no context", async () => {
    const posted: WebhookPayload[] = [];
    const service = createGrokbotService({
      loadConfig: ready([]),
      lookupThread,
      log: createSendLog(memoryKv()),
      post: async (_config, payload) => {
        posted.push(payload);
        return { ok: true, status: 204, error: null, durationMs: 3 };
      },
    });
    await service.send({ action: "ping" });
    expect(posted[0]).toMatchObject({ action: "ping", target_bot: null, text: "ping" });
    expect(posted[0]).not.toHaveProperty("context");
  });

  test("refuses before posting when unconfigured, the bot is unknown, or the text is empty", async () => {
    let posts = 0;
    const post = async () => {
      posts += 1;
      return { ok: true, status: 200, error: null, durationMs: 1 };
    };
    const log = createSendLog(memoryKv());
    const missing = createGrokbotService({
      loadConfig: async () => ({
        state: "missing",
        configPath: "/x",
        reason: "No config file at /x.",
      }),
      lookupThread,
      log,
      post,
    });
    await expect(missing.send({ action: "ping" })).rejects.toBeInstanceOf(GrokbotRefusal);
    const service = createGrokbotService({ loadConfig: ready(), lookupThread, log, post });
    await expect(service.send({ action: "ping", targetBot: "nope" })).rejects.toMatchObject({
      code: "unknown_bot",
    });
    await expect(service.send({ action: "message", text: "   " })).rejects.toMatchObject({
      code: "empty_text",
    });
    expect(posts).toBe(0);
    expect(await log.recent()).toEqual([]);
  });

  test("a log write failure still reports the delivered request", async () => {
    let posts = 0;
    const service = createGrokbotService({
      loadConfig: ready(),
      lookupThread,
      log: {
        append: async () => {
          throw new Error("database is locked");
        },
        recent: async () => [],
      },
      post: async () => {
        posts += 1;
        return { ok: true, status: 200, error: null, durationMs: 5 };
      },
    });
    const result = await service.send({ action: "message", text: "hi" });
    expect(result.outcome.ok).toBe(true);
    expect(result.logged).toBe(false);
    expect(posts).toBe(1);
  });

  test("refuses an over-long message from any caller before posting", async () => {
    let posts = 0;
    const service = createGrokbotService({
      loadConfig: ready(),
      lookupThread,
      log: createSendLog(memoryKv()),
      post: async () => {
        posts += 1;
        return { ok: true, status: 200, error: null, durationMs: 1 };
      },
    });
    await expect(
      service.send({ action: "message", text: "x".repeat(MAX_TEXT_LENGTH + 1) }),
    ).rejects.toMatchObject({ code: "too_long" });
    expect(posts).toBe(0);
  });

  test("the log keeps the newest entries up to its limit", async () => {
    const log = createSendLog(memoryKv(), 3);
    const base = {
      ts: "2026-11-02T00:00:00.000Z",
      action: "ping" as const,
      target_bot: null,
      textPreview: "ping",
      context: null,
      ok: true,
      status: 200,
      error: null,
      durationMs: 1,
    };
    await Promise.all(["1", "2", "3", "4"].map((id) => log.append({ ...base, id })));
    expect((await log.recent()).map((entry) => entry.id)).toEqual(["4", "3", "2"]);
  });
});

describe("plugin wiring", () => {
  test("a CLI ping refreshes open send logs and a refusal reaches the panel as not sent", async () => {
    const stub = await startStub();
    const previous = process.env[CONFIG_PATH_ENV];
    process.env[CONFIG_PATH_ENV] = await writeConfig("wired.json", {
      url: stub.url,
      key: DUMMY_KEY,
      bots: [{ id: "research" }],
    });
    try {
      const host = createFakePluginHost({ pluginId: "grokbot" });
      await plugin(host.bb);
      const { behavior, inspection } = host.harness;

      const ping = await behavior.runCli(["ping"]);
      expect(ping.exitCode).toBe(0);
      expect(stub.received).toHaveLength(1);
      expect(inspection.experimental_rpcInvalidations).toEqual([["send-log"]]);

      const refused = behavior.callRpc("send", { action: "ping", targetBot: "nope" });
      await expect(refused).rejects.toMatchObject({ code: "invalid" });
      expect(stub.received).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env[CONFIG_PATH_ENV];
      else process.env[CONFIG_PATH_ENV] = previous;
      await stub.close();
    }
  });
});
