import { defineCli } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, test, vi } from "vitest";
import type { Engine, ThreadContextInput } from "../../shared/contracts/engine.ts";
import { ReviewInputError } from "../../shared/review/input-error.ts";
import { files } from "../lib/instructions.ts";
import { createSettings } from "../lib/settings.ts";
import { tool } from "./tool.ts";

/** The CLI over an engine whose operations are `api`; records each run's context. */
function cli(api: object) {
  const contexts: ThreadContextInput[] = [];
  const engine = {
    api,
    run: (context: ThreadContextInput, fn: (signal: AbortSignal) => Promise<unknown>) => {
      contexts.push(context);
      return fn(new AbortController().signal);
    },
  } as unknown as Engine;
  const { bb, harness } = createFakePluginHost({ pluginId: "whiteboard" });
  bb.cli.register(
    defineCli({
      name: "whiteboard",
      summary: "CLI for the whiteboard plugin",
      commands: { tool: tool({ bb, engine, settings: createSettings(bb) }) },
    }),
  );
  return { run: (...argv: string[]) => harness.runCli(["tool", ...argv]), contexts };
}

test("with no name, lists every tool with the first line of its description", async () => {
  const result = await cli({}).run();
  expect(result.exitCode).toBe(0);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(28);
  const status = lines.find((line) => line.startsWith("whiteboard_status "))!;
  expect(status.replace(/^whiteboard_status +/, "")).toBe(
    files.tool("whiteboard_status").description.split("\n", 1)[0],
  );
  expect(lines.map((line) => line.split(" ", 1)[0])).toContain("whiteboard_session_list");
});

test("runs a tool by name and prints its result in the session vocabulary", async () => {
  const catalog = vi.fn(async () => [{ reviewId: "s1", title: "Cart" }]);
  const { run, contexts } = cli({ catalog });
  expect(await run("whiteboard_session_list")).toEqual({
    exitCode: 0,
    stdout: '[{"sessionId":"s1","title":"Cart"}]\n',
    stderr: "",
  });
  expect(catalog).toHaveBeenCalledWith({});
  // Outside an agent thread the CLI carries no thread.
  expect(contexts).toEqual([{ threadId: undefined, projectId: undefined, signal: undefined }]);
});

test("a tool error goes to stderr with exit 1", async () => {
  const inspect = async () => {
    throw new ReviewInputError("Session not found.", 404);
  };
  const { run } = cli({ inspect });
  expect(await run("whiteboard_session_get", '{"sessionId":"nope"}')).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Session not found.\n",
  });
});

test("an unknown name, bad JSON, a non-object and invalid input are refused before any call", async () => {
  const { run, contexts } = cli({});
  expect(await run("session_list")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Unknown Whiteboard tool: session_list. Run bb whiteboard tool to list them.\n",
  });
  expect((await run("whiteboard_session_list", "{oops")).exitCode).toBe(1);
  expect(await run("whiteboard_session_list", "[1]")).toEqual({
    exitCode: 1,
    stdout: "",
    stderr: "Tool input must be a JSON object.\n",
  });
  const invalid = await run("whiteboard_session_get", '{"reviewId":"s1"}');
  expect(invalid.exitCode).toBe(1);
  expect(invalid.stderr).toMatch(/sessionId/);
  expect(contexts).toEqual([]);
});
