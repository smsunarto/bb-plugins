import { expect, test } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

test("Fal auth CLI shows the managed account without exposing tokens and rejects invalid actions", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "game-studio",
    settings: {
      falOAuthCredentials: JSON.stringify({
        accessToken: "private-access",
        refreshToken: "private-refresh",
        expiresAt: 4102444800000,
        account: "scott@example.com",
      }),
    },
  });
  await plugin(bb);
  const result = await harness.runCli(["auth", "status"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout!)).toEqual({
    state: "connected",
    account: "scott@example.com",
    expiresAt: 4102444800000,
  });
  expect(result.stdout).not.toContain("private-");
  expect((await harness.runCli(["auth", "unknown"])).exitCode).toBe(1);
  await harness.lifecycle.dispose();
});
