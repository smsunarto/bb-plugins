import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CommandError, defineCommand } from "./cli.ts";
import type { CommandContext } from "./cli.ts";
import { commandDefinitions, runProgram } from "./runner.ts";

const require = createRequire(import.meta.url);

test("commander resolves to the major version this package pins (^13)", () => {
  // commander's exports map hides ./package.json — resolve the entry
  // module and read the manifest beside it.
  const entry = require.resolve("commander");
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as {
    version: string;
  };
  assert.match(manifest.version, /^13\./);
});

const greet = defineCommand({
  summary: "Greet someone",
  configure: (command) => {
    command.argument("<name>", "who to greet").option("--shout", "uppercase the greeting");
  },
  execute(_ctx, { args, options }) {
    const name = args[0] ?? "";
    const text = options["shout"] ? name.toUpperCase() : name;
    return { exitCode: 0, stdout: `hello ${text}\n` };
  },
});

const fail = defineCommand({
  summary: "Fail with a CommandError",
  execute() {
    throw new CommandError("nope", { exitCode: 3 });
  },
});

const boom = defineCommand({
  summary: "Throw a plain Error",
  execute() {
    throw new Error("kaboom");
  },
});

const commands = { greet, fail, boom };
const program = { name: "demo", summary: "Demo CLI" };
const unusedHost = {} as CommandContext;

function invokeProgram(argv: readonly string[]) {
  return runProgram(() => commandDefinitions(commands, unusedHost), argv, program);
}

test("empty argv: exit 2 with help on stderr", async () => {
  const result = await invokeProgram([]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /Usage: demo/);
  assert.match(result.stderr ?? "", /greet/);
  assert.equal(result.stdout, undefined);
});

test("--help: exit 0 with help on stdout, program name and summary shown", async () => {
  const result = await invokeProgram(["--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /Usage: demo/);
  assert.match(result.stdout ?? "", /Demo CLI/);
  assert.match(result.stdout ?? "", /Greet someone/);
  assert.equal(result.stderr, undefined);
});

test("help command: exit 0 with help on stdout", async () => {
  const result = await invokeProgram(["help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /Usage: demo/);
});

test("subcommand --help: exit 0, inherited settings capture the output", async () => {
  const result = await invokeProgram(["greet", "--help"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /who to greet/);
});

test("a run result flows through, args and options are plumbed", async () => {
  assert.deepEqual(await greet.invoke({}, ["world"]), {
    exitCode: 0,
    stdout: "hello world\n",
  });
  assert.deepEqual(await greet.invoke({}, ["world", "--shout"]), {
    exitCode: 0,
    stdout: "hello WORLD\n",
  });
});

test("missing required argument: exit 2 with commander's error", async () => {
  const result = await greet.invoke();
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /missing required argument/);
});

test("excess arguments: exit 2", async () => {
  const result = await greet.invoke({}, ["a", "b"]);
  assert.equal(result.exitCode, 2);
});

test("unknown command: exit 2", async () => {
  const result = await invokeProgram(["nope"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /unknown command/);
});

test("CommandError carries its exit code, message to stderr", async () => {
  const result = await fail.invoke();
  assert.deepEqual(result, { exitCode: 3, stderr: "nope\n" });
});

test("CommandError defaults to exit 1", () => {
  const error = new CommandError("plain");
  assert.equal(error.exitCode, 1);
  assert.equal(error.name, "CommandError");
});

test("other throws: exit 1 with the message", async () => {
  const result = await boom.invoke();
  assert.deepEqual(result, { exitCode: 1, stderr: "kaboom\n" });
});

test("host overlay reaches the command; omitted fields are undefined", async () => {
  let seen: { cwd?: string; threadId?: string; projectId?: string } | undefined;
  const record = defineCommand({
    summary: "Record the host overlay",
    execute(ctx) {
      seen = { cwd: ctx.cwd, threadId: ctx.threadId, projectId: ctx.projectId };
      return { exitCode: 0 };
    },
  });
  await record.invoke({ cwd: "/w", threadId: "t1", projectId: "p1" });
  assert.deepEqual(seen, { cwd: "/w", threadId: "t1", projectId: "p1" });
  await record.invoke();
  assert.deepEqual(seen, { cwd: undefined, threadId: undefined, projectId: undefined });
});

function typeOnly() {
  defineCommand({
    summary: "a",
    execute: (_ctx: CommandContext) => ({ exitCode: 0 }),
  });
  defineCommand({
    summary: "a",
    // @ts-expect-error a command demanding a field outside CommandContext is rejected
    execute: (_ctx: { extra(): void }) => ({ exitCode: 0 }),
  });
}
void typeOnly;
