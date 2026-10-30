import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server";

describe("the plugin's settings", () => {
  it("lists Animations, on by default, beside Web lookups", async () => {
    const host = createFakePluginHost({ pluginId: "genui" });
    await plugin(host.bb);
    expect(host.harness.registrations.settingsDescriptors).toMatchObject({
      animations: { type: "boolean", label: "Animations", default: true },
      webLookups: { type: "boolean", label: "Web lookups", default: true },
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
