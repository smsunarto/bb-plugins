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
