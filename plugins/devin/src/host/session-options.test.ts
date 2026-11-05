import { test } from "node:test";
import assert from "node:assert/strict";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";
import { createSessionOptionTranslator, withDevinSpeed } from "./session-options.ts";

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

function request(method: string, options: Record<string, unknown>, threadId = "thr_a"): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: { threadId, providerThreadId: "devin-1", input: [], options },
  });
}

function turn(policy: Policy, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "gpt-6-1-sol-medium",
    serviceTier: "default",
    providerOptions: {},
    ...POLICIES[policy],
    ...extra,
  };
}

/** The options the bridge receives for one translated request. */
function sent(line: string): Record<string, unknown> {
  return JSON.parse(line).params.options;
}

test("a turn's service tier sets Devin's speed", () => {
  const translator = createSessionOptionTranslator();
  const fast = sent(
    translator.inbound(request("turn/start", turn("accept-edits", { serviceTier: "fast" }))),
  );
  assert.equal((fast.sessionOptions as Record<string, unknown>).speed, "fast");
  const standard = sent(translator.inbound(request("turn/start", turn("accept-edits"))));
  assert.equal((standard.sessionOptions as Record<string, unknown>).speed, "standard");
});

test("each permission mode runs Devin in its matching mode", () => {
  for (const [policy, mode] of [
    ["accept-edits", "accept-edits"],
    ["auto", "smart"],
    ["full", "bypass"],
  ] as const) {
    const translator = createSessionOptionTranslator();
    const options = sent(translator.inbound(request("turn/start", turn(policy))));
    assert.equal((options.sessionOptions as Record<string, unknown>).mode, mode, policy);
  }
});

test("Auto reaches the bridge as Accept Edits, which the bridge accepts", () => {
  const translator = createSessionOptionTranslator();
  for (const method of ["thread/start", "thread/resume", "turn/start", "turn/steer"]) {
    const options = sent(translator.inbound(request(method, turn("auto"))));
    assert.equal(options.permissionMode, "accept-edits", method);
    assert.equal(options.approvalReviewer, "user", method);
  }
});

test("a plan turn runs in Plan mode and the next turn returns to the permission's mode", () => {
  const translator = createSessionOptionTranslator();
  translator.inbound(request("turn/start", turn("full")));
  const plan = sent(
    translator.inbound(request("turn/start", turn("full", { promptMode: "plan" }))),
  );
  assert.equal((plan.sessionOptions as Record<string, unknown>).mode, "plan");
  const after = sent(translator.inbound(request("turn/start", turn("full"))));
  assert.equal((after.sessionOptions as Record<string, unknown>).mode, "bypass");
});

test("a plan turn under Full asks bb to approve the plan", () => {
  const translator = createSessionOptionTranslator();
  const plan = sent(
    translator.inbound(request("turn/start", turn("full", { promptMode: "plan" }))),
  );
  assert.equal(plan.permissionMode, "accept-edits");
  assert.equal(plan.permissionScope, "workspace");
  assert.equal(plan.approvalReviewer, "user");
  assert.equal(plan.permissionEscalation, "ask");
  const after = sent(translator.inbound(request("turn/start", turn("full"))));
  assert.equal(after.permissionMode, "full");
});

test("a mode the user picks in Agent options holds until bb's implied mode changes", () => {
  const translator = createSessionOptionTranslator();
  const picked = sent(
    translator.inbound(
      request("turn/start", turn("accept-edits", { sessionOptions: { mode: "ask" } })),
    ),
  );
  assert.equal((picked.sessionOptions as Record<string, unknown>).mode, "ask");
  const next = sent(translator.inbound(request("turn/start", turn("accept-edits"))));
  assert.equal((next.sessionOptions as Record<string, unknown>).mode, undefined);
  const switched = sent(translator.inbound(request("turn/start", turn("full"))));
  assert.equal((switched.sessionOptions as Record<string, unknown>).mode, "bypass");
});

test("a reopened session sets its mode again", () => {
  const translator = createSessionOptionTranslator();
  translator.inbound(request("turn/start", turn("full")));
  translator.inbound(request("thread/resume", turn("full")));
  const options = sent(translator.inbound(request("turn/start", turn("full"))));
  assert.equal((options.sessionOptions as Record<string, unknown>).mode, "bypass");
});

test("threads track their modes independently", () => {
  const translator = createSessionOptionTranslator();
  translator.inbound(request("turn/start", turn("full"), "thr_a"));
  const other = sent(translator.inbound(request("turn/start", turn("full"), "thr_b")));
  assert.equal((other.sessionOptions as Record<string, unknown>).mode, "bypass");
});

test("lines without execution options pass unchanged", () => {
  const translator = createSessionOptionTranslator();
  const list = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "model/list", params: {} });
  assert.equal(translator.inbound(list), list);
  const start = request("thread/start", turn("full"));
  assert.equal(translator.inbound(start), start);
});

test("the Agent options menu drops Devin's Speed and keeps its Mode", () => {
  const translator = createSessionOptionTranslator();
  const line = `${JSON.stringify({
    jsonrpc: "2.0",
    method: "thread/delta",
    params: {
      threadId: "thr_a",
      deltas: [
        {
          kind: "extension.state",
          extensionKind: "bb/session-options",
          payload: {
            options: [
              {
                id: "mode",
                label: "Session Mode",
                type: "select",
                value: "accept-edits",
                values: [],
              },
              { id: "speed", label: "Speed", type: "select", value: "standard", values: [] },
            ],
          },
        },
      ],
    },
  })}\n`;
  const out = JSON.parse(translator.outbound(line));
  assert.deepEqual(
    out.params.deltas[0].payload.options.map((option: { id: string }) => option.id),
    ["mode"],
  );
  const other = `${JSON.stringify({ jsonrpc: "2.0", method: "thread/delta", params: { threadId: "thr_a", deltas: [] } })}\n`;
  assert.equal(translator.outbound(other), other);
});

test("every model offers bb's fast tier without a duplicate Speed option", () => {
  const model: AvailableModel = {
    id: "gpt-6-1-sol-medium",
    model: "gpt-6-1-sol-medium",
    displayName: "GPT-6.1 Sol",
    description: "",
    reasoningDiscovery: "known",
    supportedReasoningEfforts: [],
    defaultReasoningEffort: "medium",
    isDefault: true,
    sessionOptions: [
      { id: "mode", label: "Session Mode", type: "select", value: "accept-edits", values: [] },
      { id: "speed", label: "Speed", type: "select", value: "standard", values: [] },
    ] as AvailableModel["sessionOptions"],
  };
  const catalog = withDevinSpeed({ models: [model], selectedOnlyModels: [model] });
  for (const shown of [...catalog.models, ...catalog.selectedOnlyModels]) {
    assert.deepEqual(shown.supportedServiceTiers, [{ id: "fast" }]);
    assert.deepEqual(
      shown.sessionOptions?.map((option) => option.id),
      ["mode"],
    );
  }
});
