import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FixtureError,
  InvocationError,
  addOperation,
  initializeProject,
  runCli,
  runFixtures,
  type CliIo,
} from "../src/index.js";

const roots: string[] = [];

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), "bb-kit-fixtures-"));
  roots.push(root);
  initializeProject(root, {
    kind: "backend",
    packageName: "@acme/bb-plugin-example",
    syncTypes: false,
    install: false,
  });
  return root;
}

function writeFixture(root: string, path: string, contents: unknown): void {
  const target = join(root, "fixtures", path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    typeof contents === "string" ? contents : `${JSON.stringify(contents, null, 2)}\n`,
  );
}

function rpcResponse(envelope: unknown, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("loaded-operation fixtures", () => {
  it("runs JSON and YAML scenarios in stable path order", async () => {
    const root = temporaryProject();
    addOperation(root, "state.seed", "command", "mutating");
    addOperation(root, "state.get", "query");
    writeFixture(root, "zeta/second.json", {
      name: "second",
      invoke: { operation: "state.get", input: { id: 2 } },
      expect: { value: 2 },
    });
    writeFixture(root, "alpha/first.yaml", [
      "name: first",
      "seed:",
      "  - operation: state.seed",
      "    input:",
      "      id: 1",
      "invoke:",
      "  operation: state.get",
      "  input:",
      "    id: 1",
      "expect: null",
      "",
    ].join("\n"));
    const envelopes = [
      { ok: true, result: { seeded: true } },
      { ok: true, result: null },
      { ok: true, result: { value: 2 } },
    ];
    const request = vi.fn<typeof fetch>(async () =>
      rpcResponse(envelopes.shift()),
    );

    await expect(runFixtures(root, { fetch: request })).resolves.toEqual({
      ok: true,
      total: 2,
      passed: 2,
      failed: 0,
      scenarios: [
        {
          id: "first",
          file: "fixtures/alpha/first.yaml",
          operation: "state.get",
          status: "passed",
        },
        {
          id: "second",
          file: "fixtures/zeta/second.json",
          operation: "state.get",
          status: "passed",
        },
      ],
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:38886/api/v1/plugins/example/rpc/state_seed",
      "http://127.0.0.1:38886/api/v1/plugins/example/rpc/state_get",
      "http://127.0.0.1:38886/api/v1/plugins/example/rpc/state_get",
    ]);
    expect(request.mock.calls.map(([, init]) => init?.body)).toEqual([
      '{"id":1}',
      '{"id":1}',
      '{"id":2}',
    ]);
  });

  it("validates every selected scenario before making an RPC call", async () => {
    const root = temporaryProject();
    addOperation(root, "state.get", "query");
    writeFixture(root, "state/first.json", {
      invoke: { operation: "state.get" },
      expect: {},
    });
    writeFixture(root, "state/invalid.json", {
      invoke: { operation: "state.get" },
      expect: {},
      unexpected: true,
    });
    const request = vi.fn<typeof fetch>();

    await expect(runFixtures(root, { fetch: request })).rejects.toMatchObject({
      code: "invalid_fixture",
    } satisfies Partial<FixtureError>);
    expect(request).not.toHaveBeenCalled();

    rmSync(join(root, "fixtures"), { recursive: true });
    writeFixture(root, "state/unknown.json", {
      invoke: { operation: "state.missing" },
      expect: {},
    });
    await expect(runFixtures(root, { fetch: request })).rejects.toMatchObject({
      code: "unknown_operation",
    } satisfies Partial<InvocationError>);
    expect(request).not.toHaveBeenCalled();
  });

  it("stops after an exact-result mismatch and redacts sensitive values", async () => {
    const root = temporaryProject();
    addOperation(root, "state.get", "query");
    writeFixture(root, "state/first.json", {
      name: "first",
      invoke: { operation: "state.get" },
      expect: { token: "expected-token", nested: { apiKey: "expected-key" } },
    });
    writeFixture(root, "state/second.json", {
      name: "second",
      invoke: { operation: "state.get" },
      expect: {},
    });
    const request = vi.fn<typeof fetch>(async () => rpcResponse({
      ok: true,
      result: { token: "actual-token", nested: { apiKey: "actual-key" } },
    }));

    const result = await runFixtures(root, { fetch: request });
    expect(result).toEqual({
      ok: false,
      total: 2,
      passed: 0,
      failed: 1,
      scenarios: [
        {
          id: "first",
          file: "fixtures/state/first.json",
          operation: "state.get",
          status: "failed",
          stage: "expect",
          error: {
            code: "expectation_failed",
            message: "operation result did not exactly match expect",
          },
          expected: { token: "[REDACTED]", nested: { apiKey: "[REDACTED]" } },
          actual: { token: "[REDACTED]", nested: { apiKey: "[REDACTED]" } },
        },
        {
          id: "second",
          file: "fixtures/state/second.json",
          operation: "state.get",
          status: "skipped",
          error: { code: "previous_failure", message: "an earlier fixture failed" },
        },
      ],
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("reports the failing seed operation and redacts domain errors", async () => {
    const root = temporaryProject();
    addOperation(root, "state.seed", "command", "mutating");
    addOperation(root, "state.get", "query");
    writeFixture(root, "state/seed.json", {
      name: "seed-failure",
      seed: [{ operation: "state.seed", input: { id: 1 } }],
      invoke: { operation: "state.get" },
      expect: {},
    });
    const request = vi.fn<typeof fetch>(async () => rpcResponse({
      ok: false,
      error: {
        code: "seed_rejected",
        message: 'token="domain-secret"; Authorization: Bearer bearer-secret',
      },
    }, 409));

    const result = await runFixtures(root, { fetch: request });
    expect(result.scenarios).toEqual([
      {
        id: "seed-failure",
        file: "fixtures/state/seed.json",
        operation: "state.seed",
        status: "failed",
        stage: "seed",
        error: {
          code: "seed_rejected",
          message: "token=[REDACTED]; Authorization: Bearer [REDACTED]",
        },
      },
    ]);
    expect(request).toHaveBeenCalledOnce();
  });

  it("normalizes transport failures", async () => {
    const root = temporaryProject();
    addOperation(root, "state.get", "query");
    writeFixture(root, "state/get.json", {
      invoke: { operation: "state.get" },
      expect: {},
    });
    const request = vi.fn<typeof fetch>(async () => {
      throw new Error("network unavailable");
    });

    const result = await runFixtures(root, { fetch: request });
    expect(result.scenarios[0]).toEqual(expect.objectContaining({
      operation: "state.get",
      status: "failed",
      stage: "invoke",
      error: {
        code: "transport_error",
        message: "could not reach bb at http://127.0.0.1:38886: network unavailable",
      },
    }));
  });

  it("preflights destructive scenarios and only runs them after confirmation", async () => {
    const root = temporaryProject();
    addOperation(root, "state.get", "query");
    addOperation(root, "state.delete", "command", "destructive");
    writeFixture(root, "state/first.json", {
      name: "safe-first",
      invoke: { operation: "state.get" },
      expect: {},
    });
    writeFixture(root, "state/second.json", {
      name: "destructive-second",
      invoke: { operation: "state.delete", input: { id: 1 } },
      expect: {},
    });
    const request = vi.fn<typeof fetch>(async () => rpcResponse({ ok: true, result: {} }));

    await expect(runFixtures(root, { fetch: request })).rejects.toMatchObject({
      code: "confirmation_required",
    } satisfies Partial<InvocationError>);
    expect(request).not.toHaveBeenCalled();

    await expect(runFixtures(root, { fetch: request, confirm: true })).resolves
      .toMatchObject({ ok: true, passed: 2 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("fails explicitly when the selected fixture set is empty", async () => {
    const root = temporaryProject();
    await expect(runFixtures(root)).rejects.toMatchObject({
      code: "no_fixtures",
      message: "no fixtures found",
    } satisfies Partial<FixtureError>);
  });

  it("generates fixtures idempotently and exposes stable CLI results", async () => {
    const root = temporaryProject();
    addOperation(root, "state.get", "query");
    const generated = capture();
    expect(await runCli(
      ["add", "fixture", "state.get", "happy-path", "--json"],
      { cwd: root, io: generated.io },
    )).toBe(0);
    expect(JSON.parse(generated.stdout[0] ?? "null")).toEqual({
      ok: true,
      created: ["fixtures/state/happy-path.json"],
    });
    expect(JSON.parse(readFileSync(
      join(root, "fixtures/state/happy-path.json"),
      "utf8",
    ))).toEqual({
      name: "state.get-happy-path",
      invoke: { operation: "state.get", input: {} },
      expect: {},
    });

    const second = capture();
    expect(await runCli(
      ["add", "fixture", "state.get", "happy-path", "--json"],
      { cwd: root, io: second.io },
    )).toBe(0);
    expect(JSON.parse(second.stdout[0] ?? "null")).toEqual({ ok: true, created: [] });

    const request = vi.fn<typeof fetch>(async () => rpcResponse({
      ok: true,
      result: { unexpected: true },
    }));
    const run = capture();
    expect(await runCli(
      ["fixtures", "run", "state", "--json"],
      { cwd: root, io: run.io, fetch: request },
    )).toBe(1);
    expect(JSON.parse(run.stdout[0] ?? "null")).toEqual(expect.objectContaining({
      ok: false,
      total: 1,
      passed: 0,
      failed: 1,
      scenarios: [expect.objectContaining({
        id: "state.get-happy-path",
        stage: "expect",
        status: "failed",
      })],
    }));
  });
});
