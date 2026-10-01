import { definePlugin } from "@bb-kit/core/plugin";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test } from "vitest";
import { createSettings } from "../lib/settings.ts";
import { fakeEngine, json } from "../lib/tools/testing.ts";
import { tool } from "./tool.ts";

async function cli(handle: (request: Request) => Response | Promise<Response>) {
  const fake = fakeEngine(handle);
  const plugin = definePlugin({
    pluginId: "whiteboard",
    rpc: {},
    command: { tool },
    services: (bb) => ({ engine: fake.engine, settings: createSettings(bb) }),
  });
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  await plugin(bb);
  return { run: (...argv: string[]) => harness.runCli(["tool", ...argv]), ...fake };
}

test("with no name, lists every tool with the first line of its description", async () => {
  const { run } = await cli(() => json({}));
  const result = await run();
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(28);
  expect(lines[1]).toBe(
    "whiteboard_status                       Name the Whiteboard instance this session talks to: key (stable, preview or dev-<checkout>), channel, checkout, appVersion, cliVersion, instanceId, url, home and desktopAvailable. Call it before changing anything when the user mentions Preview, a checkout or a dev build.",
  );
  expect(lines.map((line) => line.split(" ", 1)[0])).toContain("whiteboard_session_list");
});

test("runs a tool by its bb name or its session_ name and prints upstream's text", async () => {
  const { run, contexts } = await cli(() => json([{ sessionId: "s1" }]));
  expect(await run("whiteboard_session_list")).toEqual({
    exitCode: 0,
    stdout: '[{"sessionId":"s1"}]\n',
    stderr: "",
  });
  expect(await run("session_list", "{}")).toEqual({
    exitCode: 0,
    stdout: '[{"sessionId":"s1"}]\n',
    stderr: "",
  });
  expect(contexts).toHaveLength(2);
});

test("a tool error goes to stderr with exit 1", async () => {
  const { run } = await cli(() => json({ error: "Review not found." }, 404));
  expect(await run("whiteboard_session_get", '{"sessionId":"nope"}')).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Review not found.\n",
  });
});

test("an unknown name, bad JSON and a non-object are refused before any call", async () => {
  const { run, requests } = await cli(() => json({}));
  expect(await run("session_nope")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Unknown Whiteboard tool: session_nope. Run bb whiteboard tool to list them.\n",
  });
  expect((await run("whiteboard_session_list", "{oops")).exitCode).toBe(1);
  expect(await run("whiteboard_session_list", "[1]")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Tool input must be a JSON object.\n",
  });
  expect(requests).toEqual([]);
});
