import { expect, test } from "bun:test";
import {
  createFakePluginHost,
  makeHostResponse,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { Rule } from "../shared/rules.ts";
import plugin from "./server.ts";

const MAC = "host_mac";
const LINUX = "host_linux";

function rule(id: string, instructions: string, when: Partial<Rule["when"]> = {}): Rule {
  return {
    id,
    name: "",
    enabled: true,
    instructions,
    when: { hosts: [], providers: [], models: [], projects: [], ...when },
  };
}

async function load() {
  const host = createFakePluginHost({
    pluginId: "agent-instructions",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: MAC, name: "Build Mac" }),
          makeHostResponse({ id: LINUX, name: "linux-builder" }),
        ],
      },
      providers: {
        list: async () =>
          [
            { id: "codex", displayName: "Codex" },
            { id: "claude-code", displayName: "Claude Code" },
          ] as never,
      },
      projects: { list: async () => [{ id: "proj_bb", name: "bb-plugins" }] as never },
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thr_1", projectId: "proj_bb", environmentId: "env_1" }),
      },
      environments: { get: async () => ({ id: "env_1", hostId: LINUX }) as never },
    },
  });
  await plugin(host.bb);
  return host;
}

type Harness = Awaited<ReturnType<typeof load>>["harness"];

/** Saves like the settings page: based on the revision it last read. */
async function saveAll(harness: Harness, rules: Rule[]) {
  const { revision } = (await harness.callRpc("rules")) as { revision: number };
  return harness.callRpc("saveRules", { rules, revision });
}

type Where = {
  host?: string;
  provider?: string;
  model?: string;
  project?: string;
  thread?: string;
};

async function instructionsFor(harness: Harness, where: Where = {}) {
  const resolved = await harness.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      thread: { id: where.thread ?? "thr_1" },
      host: { id: where.host ?? MAC },
      provider: { id: where.provider ?? "codex", model: where.model ?? "gpt-5.5" },
      project: { id: where.project ?? "proj_bb" },
    }),
  );
  return resolved.instructions;
}

test("rules apply only where every scope matches, in rule order", async () => {
  const { harness } = await load();
  await saveAll(harness, [
    rule("always", "Always."),
    rule("mac", "Mac only.", { hosts: [MAC] }),
    rule("opus-here", "Opus on Linux.", {
      hosts: [LINUX],
      providers: ["claude-code"],
      models: ["claude-opus-*"],
    }),
    { ...rule("off", "Disabled."), enabled: false },
    rule("blank", "  \n "),
  ]);

  expect(await instructionsFor(harness)).toBe("Always.\n\nMac only.");
  expect(await instructionsFor(harness, { host: LINUX })).toBe("Always.");
  expect(
    await instructionsFor(harness, {
      host: LINUX,
      provider: "claude-code",
      model: "CLAUDE-OPUS-5-5[1m]",
    }),
  ).toBe("Always.\n\nOpus on Linux.");
  expect(
    await instructionsFor(harness, {
      host: LINUX,
      provider: "claude-code",
      model: "claude-sonnet-5-5",
    }),
  ).toBe("Always.");
});

test("no matching rule contributes nothing", async () => {
  const { harness } = await load();
  expect(await instructionsFor(harness)).toBeNull();
  await saveAll(harness, [rule("p", "Other project.", { projects: ["proj_x"] })]);
  expect(await instructionsFor(harness)).toBeNull();
});

test("saved rules survive a plugin reload", async () => {
  const { harness } = await load();
  await saveAll(harness, [rule("a", "Persisted.", { providers: ["codex"] })]);
  const reloaded = await harness.reload(plugin);
  expect(await reloaded.harness.callRpc("rules")).toEqual({
    revision: 1,
    rules: [rule("a", "Persisted.", { providers: ["codex"] })],
  });
  expect(await instructionsFor(reloaded.harness)).toBe("Persisted.");
});

test("duplicate rule ids are rejected", async () => {
  const { harness } = await load();
  await expect(
    harness.callRpc("saveRules", { rules: [rule("a", "One."), rule("a", "Two.")], revision: 0 }),
  ).rejects.toThrow("rpc input validation failed");
  expect(await harness.callRpc("rules")).toEqual({ revision: 0, rules: [] });
});

test("the CLI adds a rule by names and `here`, lists it, and removes it", async () => {
  const { harness } = await load();
  const added = await harness.runCli(
    [
      "add",
      "Use",
      "bun.",
      "--name",
      "Bun",
      "--host",
      "here,Build Mac",
      "--provider",
      "Codex",
      "--model",
      "gpt-*",
    ],
    { cwd: "/", threadId: "thr_1" } as never,
  );
  expect(added.stderr ?? "").toBe("");
  expect(added.stdout).toMatch(
    /^Added rule_\w+, when host linux-builder or Build Mac · provider Codex · model gpt-\*\n$/,
  );
  const id = added.stdout.match(/rule_\w+/)?.[0] ?? "";

  expect(await instructionsFor(harness, { host: LINUX })).toBe("Use bun.");
  expect(await instructionsFor(harness, { provider: "claude-code" })).toBeNull();

  const listed = await harness.runCli(["list"]);
  expect(listed.stdout).toBe(
    `${id}  Bun\n  when host linux-builder or Build Mac · provider Codex · model gpt-*\n`,
  );

  const unknown = await harness.runCli(["add", "x", "--project", "nope"]);
  expect(unknown.exitCode).not.toBe(0);
  expect(unknown.stderr).toContain('Unknown project "nope"');

  expect((await harness.runCli(["remove", id])).stdout).toBe(`Removed ${id}\n`);
  expect((await harness.runCli(["list"])).stdout).toBe("No rules yet\n");
});

test("preview prints what the thread's last agent session resolved to", async () => {
  const { harness } = await load();
  await saveAll(harness, [rule("mac", "Mac only.", { hosts: [MAC] })]);
  const before = await harness.runCli(["preview", "--thread", "thr_2"]);
  expect(before.stderr).toContain("No agent session seen for thr_2");

  await instructionsFor(harness, { thread: "thr_2", model: "gpt-5.5" });
  const after = await harness.runCli(["preview", "--thread", "thr_2"]);
  expect(after.stdout).toBe(
    "host Build Mac · provider Codex · model gpt-5.5 · project bb-plugins\n\nMac only.\n",
  );
});

test("a save based on an old revision is refused and keeps rules added since", async () => {
  const { harness } = await load();
  await harness.runCli(["add", "From the CLI."]);
  const result = await harness.callRpc("saveRules", {
    rules: [rule("ui", "From a stale page.")],
    revision: 0,
  });
  expect(result).toMatchObject({ saved: false, revision: 1 });
  expect(await instructionsFor(harness)).toBe("From the CLI.");
});

test("concurrent CLI edits all land", async () => {
  const { harness } = await load();
  await Promise.all(["One.", "Two.", "Three."].map((text) => harness.runCli(["add", text])));
  expect(await instructionsFor(harness)).toBe("One.\n\nTwo.\n\nThree.");
});

test("a name shared by two projects must be given as an id", async () => {
  const { harness } = await load();
  harness.sdk.stub(
    "projects.list",
    async () =>
      [
        { id: "proj_a", name: "api" },
        { id: "proj_b", name: "API" },
      ] as never,
  );
  const result = await harness.runCli(["add", "x", "--project", "api"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain('2 projects are named "api"');
  expect(result.stderr).toContain("proj_a, proj_b");
  expect((await harness.runCli(["list"])).stdout).toBe("No rules yet\n");
});

test("a pathological model glob still resolves quickly", async () => {
  const { harness } = await load();
  await saveAll(harness, [rule("g", "Never.", { models: [`${"*".repeat(150)}z`] })]);
  const started = performance.now();
  expect(
    await instructionsFor(harness, { model: "claude-opus-4-6-with-a-long-suffix" }),
  ).toBeNull();
  expect(performance.now() - started).toBeLessThan(100);
});

test("preview shows only what fits in bb's instruction limit", async () => {
  const { harness } = await load();
  await saveAll(harness, [rule("big", "a".repeat(4096)), rule("late", "Cut off.")]);
  await instructionsFor(harness, { thread: "thr_3" });
  const { stdout } = await harness.runCli(["preview", "--thread", "thr_3"]);
  expect(stdout).not.toContain("Cut off.");
  expect(stdout).toEndWith(
    `${"a".repeat(4096)}\n\n(truncated: the agent gets 4096 of 4106 characters)\n`,
  );
});
