import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

async function withCli(
  run: (
    cli: (
      argv: string[],
      ctx?: { threadId?: string },
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>,
  ) => Promise<void>,
) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "gtd-sidebar",
    sdk: {
      subscribe: () => () => {},
      threads: {
        get: async () => {
          throw new Error("thread not found");
        },
      },
    },
  });
  await plugin(bb);
  try {
    await run((argv, ctx) => harness.behavior.runCli(argv, ctx));
  } finally {
    await harness.lifecycle.dispose();
  }
}

describe("bb gtd-sidebar CLI", () => {
  it("keeps the rename command and its usage line", async () => {
    await withCli(async (cli) => {
      const help = await cli(["--help"]);
      assert.equal(help.exitCode, 0);
      assert.match(help.stdout, /rename/);
      const renameHelp = await cli(["rename", "--help"]);
      assert.equal(renameHelp.exitCode, 0);
      assert.match(renameHelp.stdout, /bb gtd-sidebar rename \[<threadId>\]/);
    });
  });

  it("needs a thread id or a thread context", async () => {
    await withCli(async (cli) => {
      const result = await cli(["rename"]);
      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Pass a thread id or run this command from a thread\./);
    });
  });

  it("rejects an unknown subcommand with exit code 2", async () => {
    await withCli(async (cli) => {
      const result = await cli(["retitle"]);
      assert.equal(result.exitCode, 2);
      assert.match(result.stderr, /retitle/);
    });
  });

  it("reports a failed rename on stderr with exit code 1", async () => {
    await withCli(async (cli) => {
      const result = await cli(["rename"], { threadId: "thr_missing" });
      assert.equal(result.exitCode, 1);
      assert.equal(result.stdout, "");
      assert.notEqual(result.stderr, "");
    });
  });
});
