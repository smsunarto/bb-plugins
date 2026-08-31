import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { sentryPerformanceReporter } from "./performance.ts";

test("invalid DSNs and plugin identifiers disable performance reporting", () => {
  for (const dsn of [
    undefined,
    "   ",
    "not-a-sentry-dsn",
    "ftp://public@example.com/1",
    "https://example.com/1",
    "https://public@example.com/project",
    "https://public@example.com/1?secret=value",
    "https://public@example.com/1#fragment",
  ]) {
    assert.equal(sentryPerformanceReporter({ dsn })({ pluginId: "demo" }), undefined);
  }
  assert.equal(
    sentryPerformanceReporter({ dsn: "https://public@example.com/1" })({
      pluginId: "invalid plugin",
    }),
    undefined,
  );
});

test("sampling at zero drops traces and sampling at one sends them", async () => {
  const target = await startEnvelopeTarget();
  try {
    const dropped = createReporter(target.dsn, { tracesSampleRate: 0 });
    dropped.start({ operation: "cli.startup" }).finish("ok");
    await dropped.dispose(5_000);
    assert.equal(target.bodies.length, 0);

    const sent = createReporter(target.dsn, { tracesSampleRate: 1 });
    sent.start({ operation: "cli.startup" }).finish("ok");
    await sent.dispose(5_000);
    assert.equal(target.bodies.length, 1);
  } finally {
    await target.close();
  }
});

test(
  "sampling normalizes edge rates and makes fractional decisions",
  { concurrency: false },
  async (context) => {
    const target = await startEnvelopeTarget();
    try {
      for (const rate of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const reporter = createReporter(target.dsn, { tracesSampleRate: rate });
        reporter.start({ operation: "cli.startup" }).finish("ok");
        await reporter.dispose(5_000);
      }

      const clamped = createReporter(target.dsn, { tracesSampleRate: 2 });
      clamped.start({ operation: "cli.startup" }).finish("ok");
      await clamped.dispose(5_000);

      const decisions = [0.49, 0.51];
      context.mock.method(Math, "random", () => decisions.shift() ?? 1);
      try {
        const fractional = createReporter(target.dsn, { tracesSampleRate: 0.5 });
        fractional.start({ operation: "cli.startup" }).finish("ok");
        fractional.start({ operation: "cli.startup" }).finish("ok");
        await fractional.dispose(5_000);
      } finally {
        context.mock.restoreAll();
      }

      assert.equal(target.bodies.length, 2);
    } finally {
      await target.close();
    }
  },
);

test("the DSN password never reaches the endpoint or envelope", async () => {
  const target = await startEnvelopeTarget();
  try {
    const reporter = createReporter(target.dsn);
    reporter.start({ operation: "cli.startup" }).finish("ok");
    await reporter.dispose(5_000);

    assert.equal(target.urls[0], "/api/1/envelope/?sentry_version=7&sentry_key=public");
    assert.doesNotMatch(target.urls.join("\n"), /private-secret/u);
    assert.doesNotMatch(target.bodies.join("\n"), /private-secret/u);
  } finally {
    await target.close();
  }
});

test("invalid operation and variant names never form envelopes", async () => {
  const target = await startEnvelopeTarget();
  try {
    const reporter = createReporter(target.dsn);
    reporter.start({ operation: "invalid operation" }).finish("ok");
    reporter.start({ operation: "cli.startup", variant: "contains/slash" }).finish("ok");
    await reporter.dispose(5_000);
    assert.equal(target.bodies.length, 0);
  } finally {
    await target.close();
  }
});

test("checkpoints keep the first valid mark and reserve total", async () => {
  const target = await startEnvelopeTarget();
  try {
    const reporter = createReporter(target.dsn);
    const trace = reporter.start({ operation: "cli.startup" });
    trace.checkpoint("spawn_called");
    trace.checkpoint("spawn_called");
    trace.checkpoint("invalid checkpoint");
    trace.checkpoint("total");
    await delay(2);
    trace.finish("ok");
    await reporter.dispose(5_000);

    const measurements = readRecord(parseEnvelopeItem(target.bodies[0] ?? ""), "measurements");
    assert.equal(typeof readRecord(measurements, "bb.spawn_called").value, "number");
    assert.equal(typeof readRecord(measurements, "bb.total").value, "number");
    assert.equal(measurements["bb.invalid checkpoint"], undefined);
    assert.equal(Object.keys(measurements).filter((name) => name === "bb.total").length, 1);
  } finally {
    await target.close();
  }
});

test("every outcome maps to the expected Sentry status", async () => {
  const target = await startEnvelopeTarget();
  try {
    const reporter = createReporter(target.dsn);
    const expected = {
      ok: "ok",
      error: "internal_error",
      cancelled: "cancelled",
      retry: "cancelled",
      incomplete: "unknown_error",
    } as const;
    for (const outcome of Object.keys(expected) as Array<keyof typeof expected>) {
      reporter.start({ operation: `cli.${outcome}` }).finish(outcome);
    }
    await reporter.dispose(5_000);
    assert.equal(target.bodies.length, 5);
    for (const body of target.bodies) {
      const event = parseEnvelopeItem(body);
      const tags = readRecord(event, "tags");
      const outcome = tags["bb.kit.outcome"] as keyof typeof expected;
      assert.equal(readRecord(readRecord(event, "contexts"), "trace").status, expected[outcome]);
    }
  } finally {
    await target.close();
  }
});

test("network and non-2xx failures stay isolated from plugin work", async () => {
  const unavailable = await startEnvelopeTarget();
  const unavailableDsn = unavailable.dsn;
  await unavailable.close();
  const networkReporter = createReporter(unavailableDsn);
  networkReporter.start({ operation: "cli.startup" }).finish("error");
  await networkReporter.dispose(5_000);

  const rejected = await startEnvelopeTarget({ status: 503 });
  try {
    const rejectedReporter = createReporter(rejected.dsn);
    rejectedReporter.start({ operation: "cli.startup" }).finish("error");
    await rejectedReporter.dispose(5_000);
    assert.equal(rejected.bodies.length, 1);
  } finally {
    await rejected.close();
  }
});

test("concurrent traces send concurrently", async () => {
  const target = await startEnvelopeTarget({ responseDelayMs: 40 });
  try {
    const reporter = createReporter(target.dsn);
    for (let index = 0; index < 3; index += 1) {
      reporter.start({ operation: `cli.startup-${index}` }).finish("ok");
    }
    await reporter.dispose(5_000);
    assert.equal(target.bodies.length, 3);
    assert.ok(target.maxActive >= 2);
  } finally {
    await target.close();
  }
});

test("each request has its own timeout", async () => {
  const target = await startEnvelopeTarget({ hang: true });
  try {
    const reporter = createReporter(target.dsn, { requestTimeoutMs: 20 });
    reporter.start({ operation: "cli.startup" }).finish("ok");
    await target.waitForRequests(1);
    await reporter.dispose(5_000);
    await target.waitForClosedResponses(1);
    assert.equal(target.bodies.length, 1);
  } finally {
    await target.close();
  }
});

test("dispose aborts in-flight requests at its deadline and is idempotent", async () => {
  const target = await startEnvelopeTarget({ hang: true });
  try {
    const reporter = createReporter(target.dsn, { requestTimeoutMs: 10_000 });
    reporter.start({ operation: "cli.startup" }).finish("ok");
    await target.waitForRequests(1);
    const first = reporter.dispose(0);
    const second = reporter.dispose(5_000);
    assert.equal(first, second);
    await first;
    await target.waitForClosedResponses(1);
  } finally {
    await target.close();
  }
});

test("finishing after disposal sends nothing", async () => {
  const target = await startEnvelopeTarget();
  try {
    const reporter = createReporter(target.dsn);
    const trace = reporter.start({ operation: "cli.startup" });
    await reporter.dispose(5_000);
    trace.finish("ok");
    await delay(20);
    assert.equal(target.bodies.length, 0);
  } finally {
    await target.close();
  }
});

test("the built performance entry works in plain Node without the Sentry SDK", () => {
  const distPath = fileURLToPath(new URL("../dist/performance.js", import.meta.url));
  const source = readFileSync(distPath, "utf8");
  assert.doesNotMatch(source, /@sentry\/(?:node|core)/u);
  const moduleUrl = pathToFileURL(distPath).href;
  const script = `
    globalThis.fetch = async (_url, init) => {
      const event = JSON.parse(String(init.body).split("\\n")[2]);
      if (event.transaction !== "plain-node.cli.startup") throw new Error("bad event");
      return new Response("{}", { status: 200 });
    };
    const { sentryPerformanceReporter } = await import(${JSON.stringify(moduleUrl)});
    const reporter = sentryPerformanceReporter({ dsn: "https://public@example.com/1" })({ pluginId: "plain-node" });
    if (!reporter) throw new Error("reporter disabled");
    reporter.start({ operation: "cli.startup" }).finish("ok");
    await reporter.dispose(1000);
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], { stdio: "pipe" });
});

function createReporter(
  dsn: string,
  options: Readonly<{ tracesSampleRate?: number; requestTimeoutMs?: number }> = {},
) {
  const reporter = sentryPerformanceReporter({
    dsn,
    release: "demo@1.0.0",
    environment: "test",
    ...options,
  })({ pluginId: "demo" });
  if (reporter === undefined) throw new Error("reporter was unexpectedly disabled");
  return reporter;
}

interface EnvelopeTarget {
  readonly dsn: string;
  readonly bodies: string[];
  readonly urls: string[];
  readonly maxActive: number;
  waitForRequests(count: number): Promise<void>;
  waitForClosedResponses(count: number): Promise<void>;
  close(): Promise<void>;
}

async function startEnvelopeTarget(
  options: Readonly<{ status?: number; responseDelayMs?: number; hang?: boolean }> = {},
): Promise<EnvelopeTarget> {
  const bodies: string[] = [];
  const urls: string[] = [];
  const openResponses = new Set<ServerResponse>();
  let active = 0;
  let maxActive = 0;
  let closedResponses = 0;
  const waiters = new Set<() => void>();
  const wake = (): void => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const server = createServer((request, response) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    openResponses.add(response);
    response.once("close", () => {
      active -= 1;
      closedResponses += 1;
      openResponses.delete(response);
      wake();
    });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      urls.push(request.url ?? "");
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      wake();
      if (options.hang === true) return;
      setTimeout(() => {
        response.statusCode = options.status ?? 200;
        response.end("{}\n");
      }, options.responseDelayMs ?? 0);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("loopback server did not expose a TCP address");
  }
  const waitUntil = async (condition: () => boolean): Promise<void> => {
    while (!condition()) {
      await new Promise<void>((resolve) => waiters.add(resolve));
    }
  };
  return {
    dsn: `http://public:private-secret@127.0.0.1:${address.port}/1`,
    bodies,
    urls,
    get maxActive() {
      return maxActive;
    },
    waitForRequests: (count) => waitUntil(() => bodies.length >= count),
    waitForClosedResponses: (count) => waitUntil(() => closedResponses >= count),
    close: async () => {
      for (const response of openResponses) response.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (
            error === undefined ||
            (error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING"
          ) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

function parseEnvelopeItem(body: string): Record<string, unknown> {
  const lines = body.split("\n");
  const event: unknown = JSON.parse(lines[2] ?? "null");
  if (!isRecord(event)) throw new Error("Sentry envelope did not contain a transaction");
  return event;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`expected ${key} to be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
