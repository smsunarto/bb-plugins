import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  appUrl,
  assertFixturePrerequisites,
  PLUGIN_SCREENSHOT_FIXTURES,
} from "./plugin-screenshot-fixtures";
import { SCREENSHOT_ROOT } from "./plugin-screenshot-runtime";

test("fixture navigation requires the app URL rather than the ambient API server", () => {
  expect(() => appUrl("/settings", { BB_SERVER_URL: "http://localhost:19000" })).toThrow(
    "BB_APP_URL",
  );
  expect(
    appUrl("/settings", {
      BB_APP_URL: "http://localhost:11000",
      BB_SERVER_URL: "http://localhost:19000",
    }),
  ).toBe("http://localhost:11000/settings");
});

for (const failure of [null, "theme", "source", "disabled", "not-running"] as const) {
  test(`fixture prerequisite checks are read-only (${failure ?? "ready"})`, async () => {
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requests.push(`${request.method} ${path}`);
        return Response.json(
          path === "/api/v1/plugins"
            ? {
                plugins: ["amp", "monokai", "gtd-sidebar"].map((id) => ({
                  id,
                  rootDir:
                    failure === "source" ? "/other/checkout" : join(SCREENSHOT_ROOT, "plugins", id),
                  enabled: failure !== "disabled",
                  status: failure === "not-running" ? "disabled" : "running",
                })),
              }
            : {
                appearance: {
                  themeId: failure === "theme" ? "default" : "plugin:monokai:bb-monokai",
                },
              },
        );
      },
    });
    try {
      const check = assertFixturePrerequisites(server.url.href, ["amp"]);
      if (failure)
        await expect(check).rejects.toThrow(failure === "theme" ? "Monokai" : "must be running");
      else await check;
      expect(requests.sort()).toEqual(["GET /api/v1/plugins", "GET /api/v1/system/config"]);
    } finally {
      await server.stop(true);
    }
  });
}

describe("plugin screenshot foreground fixtures", () => {
  test("cover every captured README image at DPR 3", () => {
    expect([...new Set(PLUGIN_SCREENSHOT_FIXTURES.map((fixture) => fixture.plugin))]).toEqual([
      "agentation",
      "amp",
      "gh-stack",
      "gtd-sidebar",
      "monokai",
    ]);
    expect(PLUGIN_SCREENSHOT_FIXTURES).toHaveLength(11);
    expect(new Set(PLUGIN_SCREENSHOT_FIXTURES.map((fixture) => fixture.id)).size).toBe(11);
    expect(PLUGIN_SCREENSHOT_FIXTURES.filter((fixture) => fixture.plugin === "monokai")).toEqual([
      { id: "monokai/app", plugin: "monokai", filename: "app.png", width: 1512, height: 1000 },
    ]);
    for (const fixture of PLUGIN_SCREENSHOT_FIXTURES) {
      expect(fixture.width * 3).toBeGreaterThan(fixture.width * 2);
      expect(fixture.height * 3).toBeGreaterThan(fixture.height * 2);
    }
  });
});
