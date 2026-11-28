import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildSafeAgyEnv,
  hasStaticCredentialConfig,
  parseAntigravityUsageBody,
  supportsPrintUsage,
} from "./maintenance.ts";

test("parseAntigravityUsageBody parses Gemini and Claude/GPT buckets ordered shortest first", () => {
  const body = {
    conversation_id: "",
    status: "SUCCESS",
    num_turns: 0,
    command: {
      name: "usage",
      data: {
        groups: [
          {
            name: "Gemini Models",
            buckets: [
              {
                name: "Weekly Limit Remaining",
                window: "weekly",
                remaining_fraction: 0.893,
                reset_time: "2026-12-02T21:46:18Z",
              },
              {
                name: "Five Hour Limit Remaining",
                window: "5h",
                remaining_fraction: 0.634,
                reset_time: "2026-11-26T08:59:22Z",
              },
            ],
          },
          {
            name: "Claude and GPT models",
            buckets: [
              {
                name: "Five Hour Limit Remaining",
                window: "5h",
                // Omitted remaining_fraction means 0% remaining (100% used).
                reset_time: "1970-01-01T00:00:00Z",
              },
            ],
          },
        ],
      },
    },
  };

  const parsed = parseAntigravityUsageBody(body);
  assert.equal(parsed.kind, "ok");
  assert.deepEqual(parsed.windows, [
    {
      label: "Gemini 5-hour",
      usedPercent: 37,
      resetsAt: "2026-11-26T08:59:22.000Z",
    },
    {
      label: "Gemini weekly",
      usedPercent: 11,
      resetsAt: "2026-12-02T21:46:18.000Z",
    },
    {
      label: "Claude/GPT 5-hour",
      usedPercent: 100,
      resetsAt: null,
    },
  ]);
});

test("parseAntigravityUsageBody marks runs with turns or conversation_id as unsafe", () => {
  assert.deepEqual(
    parseAntigravityUsageBody({
      status: "SUCCESS",
      num_turns: 1,
      conversation_id: "conv_1",
      command: { name: "usage", data: { groups: [] } },
    }),
    { kind: "unsafe" },
  );
  assert.deepEqual(
    parseAntigravityUsageBody({
      status: "SUCCESS",
      num_turns: 0,
      conversation_id: "",
    }),
    { kind: "unsafe" },
  );
});

test("supportsPrintUsage requires agy >= 1.1.12", () => {
  assert.equal(supportsPrintUsage(null), false);
  assert.equal(supportsPrintUsage("1.1.11"), false);
  assert.equal(supportsPrintUsage("1.1.12"), true);
  assert.equal(supportsPrintUsage("1.5.17"), true);
});

test("buildSafeAgyEnv strips SSH and BROWSER variables and disables auto-update", () => {
  const env = buildSafeAgyEnv("/safe/bin", {
    HOME: "/home/dev",
    SSH_CONNECTION: "1.2.3.4 22",
    BROWSER: "/usr/bin/firefox",
    BB_THREAD_ID: "thr_1",
    GEMINI_API_KEY: "secret-key",
    AGY_ADC_AUTH: "true",
  });
  assert.equal(env.HOME, "/home/dev");
  assert.equal(env.PATH, "/safe/bin");
  assert.equal(env.GEMINI_API_KEY, "secret-key");
  assert.equal(env.AGY_ADC_AUTH, "true");
  assert.equal(env.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
  assert.equal(env.SSH_CONNECTION, undefined);
  assert.equal(env.BROWSER, undefined);
  assert.equal(env.BB_THREAD_ID, undefined);
});

test("hasStaticCredentialConfig detects API key and ADC settings", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "bb-agy-creds-"));
  try {
    assert.equal(await hasStaticCredentialConfig({ homeDir, env: {} }), false);
    assert.equal(await hasStaticCredentialConfig({ homeDir, env: { AGY_ADC_AUTH: "true" } }), true);

    await mkdir(path.join(homeDir, ".gemini", "antigravity-cli"), { recursive: true });
    await writeFile(
      path.join(homeDir, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ modelProvider: "gemini" }),
    );
    assert.equal(
      await hasStaticCredentialConfig({ homeDir, env: { GEMINI_API_KEY: "test-key" } }),
      true,
    );
    assert.equal(await hasStaticCredentialConfig({ homeDir, env: {} }), false);
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
