import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server";

describe("the plugin's settings", () => {
  it("lists Animations, on by default, beside Web lookups and Repair broken UI", async () => {
    const host = createFakePluginHost({ pluginId: "genui" });
    await plugin(host.bb);
    expect(host.harness.registrations.settingsDescriptors).toMatchObject({
      animations: { type: "boolean", label: "Animations", default: true },
      webLookups: { type: "boolean", label: "Web lookups", default: true },
      uiRepair: { type: "boolean", label: "Repair broken UI", default: true },
    });
  });
});

describe("check_ui local images", () => {
  it("rejects inaccessible evidence before publishing, and accepts a storage copy", async () => {
    const host = createFakePluginHost({
      pluginId: "genui",
      sdk: {
        threads: {
          get: async () => ({
            id: "thr_1",
            environment: { path: "/work/repo", hostId: "checkout-host" },
          }),
          storageLocation: async () => ({
            storageRootPath: "/storage/thr_1",
            hostId: "storage-host",
          }),
        },
        files: {
          read: async ({ path, hostId }) => {
            expect(hostId).toBe("storage-host");
            if (path.endsWith("/missing.png"))
              throw Object.assign(new Error("missing"), { status: 404 });
            return { path, content: "AA==", contentEncoding: "base64", sizeBytes: 1, sha256: "x" };
          },
        },
      },
    });
    try {
      await plugin(host.bb);
      const check = async (src: string) => {
        const result = await host.harness.behavior.callAgentTool("check_ui", {
          spec: `Card("Evidence", [Image(${JSON.stringify(src)})])`,
        });
        if (typeof result === "string") throw new Error(result);
        return result;
      };
      const denied = await check(
        "/home/codex/scratch/evidence/ram1328-runtime/before-after-1920-crop.png",
      );
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied)).toContain("$BB_THREAD_STORAGE");
      expect((await check("$BB_THREAD_STORAGE/before-after.png")).isError).toBe(false);
      expect((await check("$BB_THREAD_STORAGE/missing.png")).isError).toBe(true);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});

it("streams video through a confined SDK lease and renews it without reading bytes", async () => {
  let leases = 0;
  const host = createFakePluginHost({
    pluginId: "genui",
    sdk: {
      threads: {
        get: async () => ({
          id: "thr_1",
          environment: { path: "/work/repo", hostId: "checkout-host" },
        }),
        storageLocation: async () => ({
          storageRootPath: "/storage/thr_1",
          hostId: "storage-host",
        }),
      },
      files: {
        createPreview: async ({ hostId, rootPath }) => {
          expect(hostId).toBe("storage-host");
          expect(rootPath).toBe("/storage/thr_1");
          return {
            baseUrl: `/api/v1/file-previews/lease-${++leases}`,
            expiresAtMs: Date.now() + 3600_000,
          };
        },
        read: async () => {
          throw new Error("Video must not transfer whole files through RPC");
        },
      },
    },
  });
  try {
    await plugin(host.bb);
    const preview = (path: string, renew = false) =>
      host.harness.behavior.callRpc("load_video", { threadId: "thr_1", path, renew });
    expect(await preview("$BB_THREAD_STORAGE/demo clip.mp4")).toMatchObject({
      ok: true,
      url: "/api/v1/file-previews/lease-1/demo%20clip.mp4",
      owned: false,
    });
    await preview("$BB_THREAD_STORAGE/other.mp4");
    expect(leases).toBe(1);
    await preview("$BB_THREAD_STORAGE/demo clip.mp4", true);
    expect(leases).toBe(2);
    for (const path of [
      "/tmp/clip.mp4",
      "../clip.mp4",
      "$BB_THREAD_STORAGE/../../clip.mp4",
      "https://example.com/clip.mp4",
    ]) {
      expect(await preview(path)).toMatchObject({ ok: false });
    }
    expect(leases).toBe(2);
    const player = await host.harness.behavior.fetchHttp("GET", "/video-player.js");
    expect(player.status).toBe(200);
    expect(player.headers.get("content-type")).toContain("javascript");
    expect(await player.text()).toContain("video-skin");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

describe("repairing a reply whose UI block fails", () => {
  const BROKEN =
    'Here are the options.\n\n```ui\nCard("Ok", [Text("fine")])\n```\n\n```ui\nCard("Plan", [Choice("Plan", ["Basic", "Pro"])])\n```';
  const FIXED = 'Fixed.\n\n```ui\n$plan = ""\nCard("Plan", [Choice($plan, ["Basic", "Pro"])])\n```';

  async function setup(
    turnStatus: "completed" | "interrupted" = "completed",
    { failSends = 0 }: { failSends?: number } = {},
  ) {
    let failures = failSends;
    const host = createFakePluginHost({
      pluginId: "genui",
      sdk: {
        threads: {
          events: {
            list: async () => [{ type: "turn/completed", data: { status: turnStatus } }],
          },
          send: async () => {
            if (failures-- > 0) throw new Error("bb is restarting");
            return { ok: true };
          },
        },
      },
    });
    await plugin(host.bb);
    const person = makePluginAgentConfigurationContext({
      thread: { id: "thr_person", parentThreadId: null },
    });
    await host.harness.resolveAgentConfiguration(person);
    // A `bb genui ask` trial: a person reads it, but its reply stays as written.
    await host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "thr_trial", parentThreadId: "thr_person" },
        pluginMetadata: { audience: "person", trial: true },
      }),
    );
    const idle = (text: string | null, id = "thr_person") =>
      host.harness.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id }),
        lastAssistantText: text,
      });
    const sent = () =>
      host.harness.inspection.sdk.callsTo("threads.send") as [
        { threadId: string; mode: string; input: { text: string; visibility?: string }[] },
      ][];
    return { host, idle, sent };
  }

  it("asks the agent, agent-only, to resend the broken block with its errors", async () => {
    const { host, idle, sent } = await setup();
    try {
      await idle(BROKEN);
      expect(sent()).toHaveLength(1);
      const [[request]] = sent();
      expect(request).toMatchObject({ threadId: "thr_person", mode: "start" });
      expect(request.input).toHaveLength(1);
      expect(request.input[0]!.visibility).toBe("agent-only");
      expect(request.input[0]!.text).toContain("Block 2:");
      expect(request.input[0]!.text).toContain("`Choice` value must be a state variable");
      expect(request.input[0]!.text).not.toContain("Block 1:");
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("asks once per reply, never about the reply to its own request, and again for a later broken reply", async () => {
    const { host, idle, sent } = await setup();
    try {
      await idle(BROKEN);
      await idle(BROKEN); // the same idle delivered twice
      expect(sent()).toHaveLength(1);
      await idle(BROKEN.replace("Here are", "Still")); // the answer to the request, still broken
      expect(sent()).toHaveLength(1);
      await idle(BROKEN.replace("Here are", "Next")); // a later reply
      expect(sent()).toHaveLength(2);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("treats the next reply after a request as its answer, even an empty one, and ignores its idle delivered again", async () => {
    const LATER = BROKEN.replace("Here are", "Later");
    const R2 = BROKEN.replace("Here are", "Still");
    const empty = await setup();
    try {
      await empty.idle(BROKEN);
      await empty.idle(null); // the repair turn ended with no text
      await empty.idle(LATER);
      expect(empty.sent()).toHaveLength(2);
    } finally {
      await empty.host.harness.lifecycle.dispose();
    }
    const again = await setup();
    try {
      await again.idle(BROKEN);
      await again.idle(R2); // the answer, still broken
      await again.idle(R2); // its idle delivered again
      expect(again.sent()).toHaveLength(1);
    } finally {
      await again.host.harness.lifecycle.dispose();
    }
  });

  it("asks about the next broken reply when a request could not be sent", async () => {
    const { host, idle, sent } = await setup("completed", { failSends: 1 });
    try {
      await idle(BROKEN);
      await idle(BROKEN.replace("Here are", "Next"));
      expect(sent()).toHaveLength(2);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });

  it("leaves working replies, other agents' threads, stopped turns and the setting off alone", async () => {
    const { host, idle, sent } = await setup();
    try {
      await idle(FIXED);
      await idle("No blocks here.");
      await idle(null);
      await idle('Cut off.\n\n```ui\nCard("Plan", [Choice(');
      await idle(BROKEN, "thr_spawned_by_agent");
      await idle(BROKEN, "thr_trial");
      expect(host.harness.inspection.sdk.calls).toEqual([]);
      await host.harness.behavior.setSettings({ uiRepair: false });
      await idle(BROKEN);
      expect(sent()).toEqual([]);
    } finally {
      await host.harness.lifecycle.dispose();
    }
    const stopped = await setup("interrupted");
    try {
      await stopped.idle(BROKEN);
      expect(stopped.sent()).toEqual([]);
    } finally {
      await stopped.host.harness.lifecycle.dispose();
    }
  });
});
