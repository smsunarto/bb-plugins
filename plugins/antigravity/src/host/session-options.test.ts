import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAntigravitySessionTranslator,
  isAntigravityRateLimitMessage,
} from "./session-options.ts";

type Policy = "accept-edits" | "auto" | "full";

const POLICIES: Record<Policy, Record<string, unknown>> = {
  "accept-edits": {
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
  },
  auto: {
    permissionMode: "auto",
    permissionScope: "workspace",
    approvalReviewer: "automatic",
    permissionEscalation: "ask",
  },
  full: {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null,
  },
};

let nextId = 1;

function request(method: string, options: Record<string, unknown>, threadId = "thr_1"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: { threadId, providerThreadId: "agy-1", input: [], options },
  });
}

function turn(policy: Policy, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gemini-4-neon",
    serviceTier: "default",
    providerOptions: {
      acpLaunchSpec: { displayName: "Antigravity", command: "agy", args: ["acp"], env: {} },
    },
    ...POLICIES[policy],
    ...extra,
  };
}

function sent(line: string): Record<string, unknown> {
  return JSON.parse(line).params.options;
}

test("maps bb permission modes to agy session modes", () => {
  for (const [policy, expectedMode] of [
    ["accept-edits", "accept-edits"],
    ["auto", "auto"],
    ["full", "auto"],
  ] as const) {
    const translator = createAntigravitySessionTranslator();
    const options = sent(translator.inbound(request("turn/start", turn(policy))));
    assert.equal((options.sessionOptions as Record<string, unknown>).mode, expectedMode, policy);
  }
});

test("rewrites Auto to accept-edits for the SDK ACP bridge", () => {
  const translator = createAntigravitySessionTranslator();
  for (const method of ["thread/start", "thread/resume", "turn/start", "turn/steer"]) {
    const options = sent(translator.inbound(request(method, turn("auto"))));
    assert.equal(options.permissionMode, "accept-edits", method);
    assert.equal(options.approvalReviewer, "user", method);
  }
});

test("Plan turn switches to plan mode under accept-edits and restores on the next turn", () => {
  const translator = createAntigravitySessionTranslator();
  translator.inbound(request("turn/start", turn("full")));

  const plan = sent(
    translator.inbound(request("turn/start", turn("full", { promptMode: "plan" }))),
  );
  assert.equal((plan.sessionOptions as Record<string, unknown>).mode, "plan");
  assert.equal(plan.permissionMode, "accept-edits");

  const next = sent(translator.inbound(request("turn/start", turn("full"))));
  assert.equal((next.sessionOptions as Record<string, unknown>).mode, "auto");
  assert.equal(next.permissionMode, "full");
});

test("reopening a session resets implied mode tracking", () => {
  const translator = createAntigravitySessionTranslator();
  translator.inbound(request("turn/start", turn("full")));
  const same = sent(translator.inbound(request("turn/start", turn("full"))));
  assert.equal(same.sessionOptions, undefined);

  translator.inbound(request("thread/resume", turn("full")));
  const resumed = sent(translator.inbound(request("turn/start", turn("full"))));
  assert.equal((resumed.sessionOptions as Record<string, unknown>).mode, "auto");
});

test("applies BB_ANTIGRAVITY_EXECUTABLE override to default agy launch specs", () => {
  const translator = createAntigravitySessionTranslator({ executableOverride: "/opt/bin/agy" });
  const options = sent(translator.inbound(request("thread/start", turn("full"))));
  const launch = (options.providerOptions as Record<string, Record<string, unknown>>).acpLaunchSpec;
  assert.equal(launch?.command, "/opt/bin/agy");

  const modelList = JSON.parse(
    translator.inbound(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "model/list",
        params: {
          providerOptions: {
            acpLaunchSpec: { displayName: "Antigravity", command: "agy", args: ["acp"], env: {} },
          },
        },
      }),
    ),
  );
  assert.equal(modelList.params.providerOptions.acpLaunchSpec.command, "/opt/bin/agy");
});

test("injects --gemini-dir, --app-data-dir, and keyring isolation when pooled env vars are present", () => {
  const translator = createAntigravitySessionTranslator();
  const options = sent(
    translator.inbound(
      request(
        "thread/start",
        turn("full", {
          envVars: {
            BB_ANTIGRAVITY_GEMINI_DIR: "/home/user/.bb-plugins/profiles/acc-1/.gemini",
            BB_ANTIGRAVITY_APP_DATA_DIR: "antigravity-cli",
            BB_ANTIGRAVITY_DISABLE_KEYRING: "1",
          },
        }),
      ),
    ),
  );
  const launch = (options.providerOptions as Record<string, Record<string, unknown>>).acpLaunchSpec;
  assert.ok(launch);
  assert.deepEqual(launch.args, [
    "acp",
    "--gemini-dir",
    "/home/user/.bb-plugins/profiles/acc-1/.gemini",
    "--app-data-dir",
    "antigravity-cli",
  ]);
  assert.equal((launch.env as Record<string, string>).DBUS_SESSION_BUS_ADDRESS, "");
  assert.equal((options.envVars as Record<string, string>).DBUS_SESSION_BUS_ADDRESS, "");
});

test("drops redundant mode option from outbound bb/session-options deltas", () => {
  const translator = createAntigravitySessionTranslator();
  const line = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "thread/delta",
    params: {
      threadId: "thr_1",
      deltas: [
        {
          kind: "extension.state",
          extensionKind: "bb/session-options",
          payload: {
            options: [
              { id: "mode", label: "Mode", type: "select", value: "default", values: [] },
              { id: "extra", label: "Extra", type: "boolean", value: false },
            ],
          },
        },
      ],
    },
  })}\n`;
  const out = JSON.parse(translator.outbound(line));
  assert.deepEqual(
    out.params.deltas[0].payload.options.map((opt: { id: string }) => opt.id),
    ["extra"],
  );
});

test("emits typed rateLimited provider/recovery notification for Antigravity quota errors", () => {
  const translator = createAntigravitySessionTranslator();
  const quotaError = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "error",
    params: {
      threadId: "thr_1",
      message: "RESOURCE_EXHAUSTED: You have exhausted your quota for Gemini models.",
    },
  })}\n`;

  const outLines = translator
    .outbound(quotaError)
    .trim()
    .split("\n")
    .map((entry) => JSON.parse(entry));

  assert.equal(outLines.length, 2);
  assert.equal(outLines[0].method, "error");
  assert.equal(outLines[1].method, "provider/recovery");
  assert.deepEqual(outLines[1].params, {
    threadId: "thr_1",
    kind: "rateLimited",
    message: "RESOURCE_EXHAUSTED: You have exhausted your quota for Gemini models.",
    retryable: false,
  });

  // Non-rate-limit errors (including paths mentioning /quota) do not emit recovery hints.
  const regularError = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "error",
    params: {
      threadId: "thr_1",
      message: "ENOENT: failed reading /tmp/quota.log",
    },
  })}\n`;
  assert.equal(translator.outbound(regularError), regularError);
  assert.equal(isAntigravityRateLimitMessage("HTTP 429 Too Many Requests"), true);
});
