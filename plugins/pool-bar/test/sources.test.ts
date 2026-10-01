import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { parseCodexCredential } from "../src/server/lib/credentials.ts";
import { claudeExtras } from "../src/server/lib/extras.ts";
import { createSourceReader } from "../src/server/lib/sources.ts";

const resource = {
  id: "local",
  providerId: "codex",
  label: "Codex",
  scope: { kind: "host", hostId: "mac" },
};
const signal = new AbortController().signal;

test("fallback keeps failed collections until Refresh and isolates the next account", async () => {
  let generation = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "pool-bar",
    sdk: {
      system: { config: async () => ({ primaryHostId: "mac" }) },
      plugins: {
        experimental_discoverRpc: async () => [{ pluginId: "provider-codex" }],
        callRpc: async ({ method }) => {
          if (method.endsWith("listResources")) return { resources: [resource] };
          generation += 1;
          return generation === 1
            ? {
                accountKey: "openai:chatgpt:old",
                observedAt: null,
                usage: { status: "unauthenticated" },
              }
            : {
                accountKey: "openai:chatgpt:new",
                observedAt: 12,
                usage: { status: "ok", accountEmail: "same@example.com", windows: [] },
              };
        },
      },
    },
  });
  try {
    const read = createSourceReader(bb);
    const first = await read(signal, false);
    expect(first.providers[0]?.accounts[0]).toMatchObject({
      id: "provider-codex:local:openai:chatgpt:old",
      status: "error",
      error: "Not signed in",
    });
    expect((await read(signal, false)).providers[0]?.accounts[0]).toMatchObject({
      status: "error",
      error: "Not signed in",
    });
    const refreshed = await read(signal, true);
    expect(refreshed.providers[0]?.accounts[0]).toMatchObject({
      id: "provider-codex:local:openai:chatgpt:new",
      identity: "same@example.com",
      status: "ready",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("Codex workspace identity can come from the ID token", () => {
  const jwt = (body: unknown) =>
    `header.${Buffer.from(JSON.stringify(body)).toString("base64url")}.signature`;
  expect(
    parseCodexCredential({
      tokens: {
        access_token: jwt({ exp: 4102444800 }),
        id_token: jwt({
          email: "same@example.com",
          "https://api.openai.com/auth": { chatgpt_account_id: "workspace" },
        }),
      },
    }),
  ).toMatchObject({
    accountId: "workspace",
    accountKey: "openai:chatgpt:workspace",
    email: "same@example.com",
  });
});

test("Claude throttling makes one request and surface gating yields a usage-page notice", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return requests === 1
      ? Response.json({}, { status: 429 })
      : Response.json({
          cedar_ember: { eligible: false, ineligible_reason: "surface", grants: [] },
          extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1000 },
        });
  };
  try {
    expect(await claudeExtras("fixture-token")).toEqual({
      resetCredits: null,
      extraUsage: null,
      resetNotice: null,
    });
    expect(requests).toBe(1);
    expect(await claudeExtras("fixture-token")).toEqual({
      resetCredits: null,
      extraUsage: { kind: "spend", used: 10, limit: 50, currency: "USD" },
      resetNotice: "Check Claude for full resets",
    });
  } finally {
    globalThis.fetch = original;
  }
});
