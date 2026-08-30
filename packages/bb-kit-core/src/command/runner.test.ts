import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram, runProgram } from "./runner.ts";
import type { ProgramDefinition } from "./runner.ts";

test("runProgram builds a FRESH program per invocation", async () => {
  let builds = 0;
  const makeDefinitions = (): ProgramDefinition[] => {
    builds += 1;
    return [{ name: "noop", summary: "Do nothing", action: () => ({ exitCode: 0 }) }];
  };
  await runProgram(makeDefinitions, ["noop"], {});
  await runProgram(makeDefinitions, ["noop"], {});
  assert.equal(builds, 2);
});

test("nested children dispatch and expose metadata", async () => {
  const definitions: ProgramDefinition[] = [
    {
      name: "outer",
      summary: "Outer group",
      children: [
        {
          name: "inner",
          summary: "Inner leaf",
          configure: (command) => {
            command.argument("<value>", "a value");
          },
          action: (command) => ({
            exitCode: 0,
            stdout: `${command.processedArgs[0]}\n`,
          }),
        },
      ],
    },
  ];
  const result = await runProgram(() => definitions, ["outer", "inner", "x"], { name: "p" });
  assert.deepEqual(result, { exitCode: 0, stdout: "x\n" });

  const program = buildProgram(definitions, { name: "p" });
  const outer = program.commands.find((command) => command.name() === "outer");
  assert.equal(outer?.summary(), "Outer group");
  assert.equal(
    outer?.commands.find((command) => command.name() === "inner")?.summary(),
    "Inner leaf",
  );
});

test("a user-supplied .action() in configure is inert", async () => {
  const definitions: ProgramDefinition[] = [
    {
      name: "cmd",
      summary: "s",
      configure: (command) => {
        command.action(() => {
          throw new Error("user action ran");
        });
      },
      action: () => ({ exitCode: 0, stdout: "framework\n" }),
    },
  ];
  const result = await runProgram(() => definitions, ["cmd"], {});
  assert.deepEqual(result, { exitCode: 0, stdout: "framework\n" });
});

test("a failing unhandled-error observer cannot replace the command result", async () => {
  const result = await runProgram(
    () => [
      {
        name: "fail",
        summary: "Fail",
        action() {
          throw new Error("original");
        },
      },
    ],
    ["fail"],
    {
      onUnhandledError() {
        throw new Error("observer");
      },
    },
  );
  assert.deepEqual(result, { exitCode: 1, stderr: "original\n" });
});
