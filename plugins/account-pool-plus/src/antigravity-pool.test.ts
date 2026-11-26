import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  AntigravityHostRuntime,
  parseGeminiUsagePayload,
  resolveAntigravityProfilePaths,
} from "./antigravity-host-runtime.js";
import type { AntigravityHostBridge } from "./antigravity-login.js";
import { retryAvailabilityMethod } from "./retry-contract.js";
import { createAccountPoolPlugin } from "./server.js";
import { usageFetchMethod, usageListMethod } from "./usage-contract.js";

describe("parseGeminiUsagePayload", () => {
  it("extracts only Gemini 5h and weekly buckets and ignores Claude/GPT buckets", () => {
    const parsed = parseGeminiUsagePayload({
      status: "SUCCESS",
      num_turns: 0,
      conversation_id: "",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Claude and GPT models",
              buckets: [
                {
                  name: "5h",
                  window: "5h",
                  remaining_fraction: 0,
                  reset_time: "2026-11-26T10:00:00Z",
                },
                {
                  name: "weekly",
                  window: "weekly",
                  remaining_fraction: 0.1,
                  reset_time: "2026-12-01T00:00:00Z",
                },
              ],
            },
            {
              name: "Gemini Models",
              buckets: [
                {
                  name: "weekly",
                  window: "weekly",
                  remaining_fraction: 0.75,
                  reset_time: "2026-12-02T00:00:00Z",
                },
                {
                  name: "5h",
                  window: "5h",
                  remaining_fraction: 0.6,
                  reset_time: "2026-11-26T08:00:00Z",
                },
              ],
            },
          ],
        },
      },
    });
    expect(parsed).toEqual({
      kind: "ok",
      windows: [
        {
          slot: "primary",
          windowMinutes: 300,
          utilization: 0.4,
          resetAt: Date.parse("2026-11-26T08:00:00Z"),
        },
        {
          slot: "secondary",
          windowMinutes: 10_080,
          utilization: 0.25,
          resetAt: Date.parse("2026-12-02T00:00:00Z"),
        },
      ],
    });
  });

  it("treats omitted remaining_fraction as 100% utilized and epoch-zero reset as null", () => {
    const parsed = parseGeminiUsagePayload({
      status: "SUCCESS",
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  name: "5h",
                  window: "5h",
                  reset_time: "1970-01-01T00:00:00Z",
                },
              ],
            },
          ],
        },
      },
    });
    expect(parsed).toEqual({
      kind: "ok",
      windows: [
        {
          slot: "primary",
          windowMinutes: 300,
          utilization: 1,
          resetAt: null,
        },
      ],
    });
  });
});

describe("AntigravityHostRuntime", () => {
  it("runs isolated loginStart, loginComplete, probeUsage, and removeProfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-agy-runtime-test-"));
    const scriptPath = join(dir, "mock-agy.mjs");
    await writeFile(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.includes('--login')) {",
        "  process.stdout.write('Open this link:\\n  https://accounts.google.com/o/oauth2/auth?client_id=test&state=abc\\n');",
        "  process.stdin.setEncoding('utf8');",
        "  process.stdin.once('data', (chunk) => {",
        "    if (chunk.trim() === 'good-code') process.exit(0);",
        "    process.stderr.write('invalid code\\n');",
        "    process.exit(1);",
        "  });",
        "} else if (args.includes('/usage')) {",
        "  process.stdout.write(JSON.stringify({",
        "    status: 'SUCCESS',",
        "    command: {",
        "      name: 'usage',",
        "      data: {",
        "        groups: [",
        "          { name: 'Gemini Models', buckets: [{ name: '5h', window: '5h', remaining_fraction: 0.8, reset_time: '2026-11-26T12:00:00Z' }] },",
        "          { name: 'Claude and GPT models', buckets: [{ name: '5h', window: '5h', remaining_fraction: 0, reset_time: '2026-11-26T12:00:00Z' }] }",
        "        ]",
        "      }",
        "    }",
        "  }));",
        "  process.exit(0);",
        "}",
      ].join("\n"),
      "utf8",
    );
    await chmod(scriptPath, 0o755);

    const runtime = new AntigravityHostRuntime({ baseDir: join(dir, "profiles") });
    const profileId = "11111111-1111-4111-8111-111111111111";
    try {
      const started = await runtime.loginStart({ profileId, command: scriptPath });
      expect(started.authorizeUrl).toBe(
        "https://accounts.google.com/o/oauth2/auth?client_id=test&state=abc",
      );
      expect(started.geminiDir).toBe(
        resolveAntigravityProfilePaths(profileId, join(dir, "profiles")).geminiDir,
      );

      const completed = await runtime.loginComplete({
        sessionId: started.sessionId,
        pasted: "good-code",
      });
      expect(completed.usage.status).toBe("ok");
      expect(completed.usage.windows).toEqual([
        {
          slot: "primary",
          windowMinutes: 300,
          utilization: 0.2,
          resetAt: Date.parse("2026-11-26T12:00:00Z"),
        },
      ]);

      const removed = await runtime.removeProfile({ profileId });
      expect(removed.removed).toBe(true);
      await expect(stat(started.profileHomeDir)).rejects.toThrow();
    } finally {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Account Pooler+ Antigravity integration", () => {
  it("adds two Antigravity profiles, routes env, fails over on retry, and exposes usage", async () => {
    const nowValue = 1_764_100_000_000;
    const removedProfiles: Array<{ hostId: string; profileId: string }> = [];
    const sessions = new Map<string, { hostId: string; profileId: string }>();

    const bridge: AntigravityHostBridge = {
      async loginStart(hostId, input) {
        const sessionId = input.profileId;
        sessions.set(sessionId, { hostId, profileId: input.profileId });
        return {
          sessionId,
          authorizeUrl: `https://accounts.google.com/o/oauth2/auth?state=${input.profileId}`,
          profileHomeDir: `/profiles/${input.profileId}`,
          geminiDir: `/profiles/${input.profileId}/.gemini`,
          appDataDir: "antigravity-cli",
        };
      },
      async loginComplete(_hostId, input) {
        const session = sessions.get(input.sessionId);
        if (!session) throw new Error("missing session");
        return {
          profileHomeDir: `/profiles/${session.profileId}`,
          geminiDir: `/profiles/${session.profileId}/.gemini`,
          appDataDir: "antigravity-cli",
          usage: {
            status: "ok",
            windows: [
              {
                slot: "primary",
                windowMinutes: 300,
                utilization: 0.2,
                resetAt: nowValue + 3_600_000,
              },
              {
                slot: "secondary",
                windowMinutes: 10_080,
                utilization: 0.1,
                resetAt: nowValue + 86_400_000,
              },
            ],
            message: null,
          },
        };
      },
      async loginCancel() {
        return { cancelled: true };
      },
      async probeUsage() {
        return {
          status: "ok",
          windows: [
            {
              slot: "primary",
              windowMinutes: 300,
              utilization: 0.35,
              resetAt: nowValue + 3_600_000,
            },
          ],
          message: null,
        };
      },
      async removeProfile(hostId, input) {
        removedProfiles.push({ hostId, profileId: input.profileId });
        return { removed: true };
      },
    };

    const dataDir = await mkdtemp(join(tmpdir(), "bb-agy-pool-server-"));
    const host = createFakePluginHost({
      pluginId: "account-pool-plus",
      dataDir,
      sdk: {
        hosts: {
          list: async () => [{ id: "host-1", name: "scott-linux" }],
        },
      },
    });
    try {
      await createAccountPoolPlugin({
        now: () => nowValue,
        antigravityBridge: bridge,
      })(host.bb);

      const start1 = (await host.harness.behavior.callRpc("antigravityLogin.start", {
        kind: "add",
        label: "Google Primary",
        priority: 10,
        hostId: "host-1",
      })) as { sessionId: string; authorizeUrl: string; hostId: string };
      expect(start1.hostId).toBe("host-1");
      const acc1 = (await host.harness.behavior.callRpc("antigravityLogin.complete", {
        sessionId: start1.sessionId,
        pasted: "code-1",
      })) as {
        id: string;
        antigravityProfileId: string;
        antigravityGeminiDir: string;
      };

      const start2 = (await host.harness.behavior.callRpc("antigravityLogin.start", {
        kind: "add",
        label: "Google Backup",
        priority: 20,
        hostId: "host-1",
      })) as { sessionId: string };
      const acc2 = (await host.harness.behavior.callRpc("antigravityLogin.complete", {
        sessionId: start2.sessionId,
        pasted: "code-2",
      })) as {
        id: string;
        antigravityProfileId: string;
        antigravityGeminiDir: string;
      };

      const health = await host.harness.behavior.resolveProviderEnvHealth("antigravity", {
        hostId: "host-1",
      });
      expect(health?.label).toBe("Pooled");

      const envFirst = await host.harness.behavior.resolveProviderEnv("antigravity", {
        hostId: "host-1",
        threadId: "thr-1",
        projectId: "proj-1",
      });
      const envMap1 = Object.fromEntries(envFirst.map((entry) => [entry.name, entry.value]));
      expect(envMap1["BB_ANTIGRAVITY_GEMINI_DIR"]).toBe(acc1.antigravityGeminiDir);
      expect(envMap1["BB_ANTIGRAVITY_DISABLE_KEYRING"]).toBe("1");
      expect(envMap1["BB_ANTIGRAVITY_POOL_ACCOUNT_ID"]).toBe(acc1.id);

      // Trigger retry availability -> holds acc1 and clears thr-1 affinity -> next resolve picks acc2
      const retry = (await host.harness.behavior.callRpc(retryAvailabilityMethod, {
        threadId: "thr-1",
        requestId: "req-1",
      })) as { kind: string };
      expect(retry.kind).toBe("ready");

      const envAfterFailover = await host.harness.behavior.resolveProviderEnv("antigravity", {
        hostId: "host-1",
        threadId: "thr-1",
        projectId: "proj-1",
      });
      const envMap2 = Object.fromEntries(
        envAfterFailover.map((entry) => [entry.name, entry.value]),
      );
      expect(envMap2["BB_ANTIGRAVITY_POOL_ACCOUNT_ID"]).toBe(acc2.id);

      // Usage source lists both Antigravity accounts
      const usageList = (await host.harness.behavior.callRpc(usageListMethod, {})) as {
        resources: Array<{ id: string; providerId: string }>;
      };
      expect(usageList.resources.map((r) => r.providerId)).toEqual(["antigravity", "antigravity"]);

      const usageFetched = (await host.harness.behavior.callRpc(usageFetchMethod, {
        resourceId: acc1.id,
        refresh: true,
      })) as {
        usage: { status: string; windows: Array<{ usedPercent: number }> };
      };
      expect(usageFetched.usage.status).toBe("ok");
      expect(usageFetched.usage.windows[0]?.usedPercent).toBe(35);

      // Removing acc1 invokes host profile cleanup
      await host.harness.behavior.callRpc("account.remove", { id: acc1.id });
      expect(removedProfiles).toEqual([{ hostId: "host-1", profileId: acc1.antigravityProfileId }]);
    } finally {
      await host.harness.lifecycle.dispose();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
