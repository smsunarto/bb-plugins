import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import type {
  ChatGptSubscriptionHandle,
  DefaultAgent,
  NamedTool,
  SubscriptionRevision,
} from "nanocodex/host";
import { Agent } from "nanocodex/node";
import { ChatGptSubscription } from "nanocodex/worker";
import {
  createProcessBinding,
  initializeEmbeddedNanocodexModule,
} from "../src/binding.ts";
import { createNanocodexStorage } from "../src/storage.ts";

test("one compiled module and one ChatGPT subscription serve every agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-binding-"));
  const modules: unknown[] = [];
  const agentOptions: Agent.create.Options[] = [];
  let opens = 0;
  let disposals = 0;
  const handle: ChatGptSubscriptionHandle = {
    id: "nanocodex",
    startLogin: async () => ({ state: "signed_out" }),
    status: async () => ({ state: "authenticated", accountId: "account", expiresAt: null }),
    credential: async () => ({
      kind: "chatgpt",
      accessToken: "not-logged",
      accountId: "account",
      fedramp: false,
      revision: "1" as SubscriptionRevision,
    }),
    recover: async () => ({
      kind: "chatgpt",
      accessToken: "not-logged",
      accountId: "account",
      fedramp: false,
      revision: "1" as SubscriptionRevision,
    }),
    logout: async () => {},
    dispose: () => { disposals += 1; },
  };
  const openSubscription = (async (options: Parameters<typeof ChatGptSubscription.open>[0]) => {
    opens += 1;
    modules.push(options.module);
    return handle;
  }) as typeof ChatGptSubscription.open;
  const createAgent = (async (options: Agent.create.Options) => {
    agentOptions.push(options);
    modules.push(options.module);
    return {} as DefaultAgent;
  }) as typeof Agent.create;
  const parallelWebTool = {
    name: "web__run",
    description: "test",
    handler() {},
  } satisfies NamedTool;
  try {
    const binding = createProcessBinding(createNanocodexStorage(root), {
      openSubscription,
      createAgent,
      readSeed: async () => undefined,
      parallelWebTool,
    });
    await Promise.all([
      binding.health(),
      binding.createAgent({ model: "gpt-5.6-sol", thinking: "high", fastMode: false, workspace: "/a" }),
      binding.createAgent({ model: "gpt-5.6-terra", thinking: "max", fastMode: true, workspace: "/b" }),
    ]);
    const module = await initializeEmbeddedNanocodexModule();
    assert.equal(opens, 1);
    assert.deepEqual(modules, [module, module, module]);
    assert.deepEqual(agentOptions.map((options) => options.tools), [
      [parallelWebTool],
      [parallelWebTool],
    ]);
    await binding.close();
    await binding.close();
    assert.equal(disposals, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health starts the native ChatGPT device-login lifecycle when signed out", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-login-"));
  let starts = 0;
  const handle = {
    id: "nanocodex",
    startLogin: async () => {
      starts += 1;
      return {
        state: "pending" as const,
        verificationUrl: "https://example.test/device",
        userCode: "ABCD-EFGH",
        expiresAt: 123,
        pollAfterMs: 1_000,
      };
    },
    status: async () => ({ state: "signed_out" as const }),
    credential: async () => { throw new Error("unused"); },
    recover: async () => { throw new Error("unused"); },
    logout: async () => {},
    dispose() {},
  } satisfies ChatGptSubscriptionHandle;
  try {
    const binding = createProcessBinding(createNanocodexStorage(root), {
      openSubscription: (async () => handle) as typeof ChatGptSubscription.open,
      readSeed: async () => undefined,
    });
    assert.deepEqual(await binding.health({ beginLogin: true }), {
      state: "pending",
      verificationUrl: "https://example.test/device",
      userCode: "ABCD-EFGH",
      expiresAt: 123,
    });
    assert.equal(starts, 1);
    await binding.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("health distinguishes a broken auth seed from signed-out device login", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanocodex-broken-auth-"));
  let starts = 0;
  const handle = {
    id: "nanocodex",
    startLogin: async () => {
      starts += 1;
      return { state: "signed_out" as const };
    },
    status: async () => ({ state: "signed_out" as const }),
    credential: async () => { throw new Error("unused"); },
    recover: async () => { throw new Error("unused"); },
    logout: async () => {},
    dispose() {},
  } satisfies ChatGptSubscriptionHandle;
  try {
    const binding = createProcessBinding(createNanocodexStorage(root), {
      openSubscription: (async () => handle) as typeof ChatGptSubscription.open,
      inspectSeed: async () => ({
        state: "broken",
        path: "/redacted/auth.json",
        message: "The Codex auth file has conflicting account IDs.",
      }),
    });
    assert.deepEqual(await binding.health({ beginLogin: true }), {
      state: "broken",
      message: "The Codex auth file has conflicting account IDs.",
    });
    assert.equal(starts, 0);
    await binding.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
