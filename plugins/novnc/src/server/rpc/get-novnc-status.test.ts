import { test } from "bun:test";
import assert from "node:assert/strict";
import { stubHostContext } from "@bb-kit/core/testing";
import type { Context } from "@bb-kit/core/plugin";
import { getNovncStatus } from "./get-novnc-status.ts";

interface ProbeResult {
  running: boolean;
  detail?: string;
}

function makeContext(
  options: {
    environmentId?: string | null;
    hostId?: string;
    ensureSharedPortTunnel?: () => Promise<{ label: string; baseDomain: string }>;
    checkNovnc?: () => Promise<ProbeResult>;
    declared?: { hostId: string; ports: readonly number[] }[];
    probeCalls?: { method: string; hostId: string }[];
  } = {},
): Context {
  const bb = {
    sdk: {
      threads: {
        get: async () => ({
          environmentId: options.environmentId === undefined ? "env-1" : options.environmentId,
        }),
      },
      environments: {
        get: async () => ({ hostId: options.hostId ?? "host-1" }),
      },
    },
    hosts: {
      declareSharedPorts: (hostId: string, ports: readonly number[]) => {
        options.declared?.push({ hostId, ports });
      },
      ensureSharedPortTunnel:
        options.ensureSharedPortTunnel ??
        (async () => ({ label: "machine", baseDomain: "tunnel.example.com" })),
      experimental_client: () => ({
        call: async (method: string, _input: unknown, callOptions: { hostId: string }) => {
          options.probeCalls?.push({ method, hostId: callOptions.hostId });
          const probe = options.checkNovnc ?? (async () => ({ running: true }));
          return probe();
        },
      }),
    },
  };
  return stubHostContext({ bb: bb as never });
}

test("reports no-host when the thread has no environment", async () => {
  const ctx = makeContext({ environmentId: null });

  assert.deepEqual(await getNovncStatus.execute(ctx, { threadId: "thr-1" }), {
    state: "unavailable",
    reason: "no-host",
  });
});

test("reports tunnel-unavailable with detail when the tunnel cannot be ensured", async () => {
  const ctx = makeContext({
    ensureSharedPortTunnel: async () => {
      throw new Error("host not enrolled");
    },
  });

  assert.deepEqual(await getNovncStatus.execute(ctx, { threadId: "thr-1" }), {
    state: "unavailable",
    reason: "tunnel-unavailable",
    detail: "host not enrolled",
  });
});

test("reports ready with the resize URL when the host probe finds NoVNC", async () => {
  const declared: { hostId: string; ports: readonly number[] }[] = [];
  const probeCalls: { method: string; hostId: string }[] = [];
  const ctx = makeContext({ declared, probeCalls });

  assert.deepEqual(await getNovncStatus.execute(ctx, { threadId: "thr-1" }), {
    state: "ready",
    url: "https://machine--6080.tunnel.example.com/vnc.html?resize=remote",
  });
  assert.deepEqual(declared, [{ hostId: "host-1", ports: [6080] }]);
  assert.deepEqual(probeCalls, [{ method: "checkNovnc", hostId: "host-1" }]);
});

test("reports not-running with the probe's detail when NoVNC does not answer", async () => {
  const ctx = makeContext({
    checkNovnc: async () => ({ running: false, detail: "HTTP 404" }),
  });

  assert.deepEqual(await getNovncStatus.execute(ctx, { threadId: "thr-1" }), {
    state: "unavailable",
    reason: "not-running",
    detail: "HTTP 404",
  });
});

test("reports not-running when the host probe call throws", async () => {
  const ctx = makeContext({
    checkNovnc: async () => {
      throw new Error("daemon unreachable");
    },
  });

  assert.deepEqual(await getNovncStatus.execute(ctx, { threadId: "thr-1" }), {
    state: "unavailable",
    reason: "not-running",
    detail: "daemon unreachable",
  });
});
