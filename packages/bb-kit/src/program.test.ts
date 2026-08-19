import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProgram, runProgram } from "./program.ts";
import type { SubcommandDefinition } from "./program.ts";

test("runProgram builds a FRESH program per invocation", async () => {
  let builds = 0;
  const makeDefinitions = (): SubcommandDefinition[] => {
    builds += 1;
    return [{ name: "noop", summary: "Do nothing", action: () => ({ exitCode: 0 }) }];
  };
  await runProgram(makeDefinitions, ["noop"], {});
  await runProgram(makeDefinitions, ["noop"], {});
  assert.equal(builds, 2);
});

test("nested children dispatch and expose metadata", async () => {
  const definitions: SubcommandDefinition[] = [
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
  const definitions: SubcommandDefinition[] = [
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
