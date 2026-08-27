import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { argv, CommandError, defineCommand } from "./command.ts";
import type { CommandContext } from "./command.ts";
import { commandDefinitions, runProgram } from "./runner.ts";

const require = createRequire(import.meta.url);

test("commander resolves to the major version this package pins (^13)", () => {
  const entry = require.resolve("commander");
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as {
    version: string;
  };
  assert.match(manifest.version, /^13\./);
});

const greet = defineCommand({
  summary: "Greet someone",
  input: z.object({
    name: argv.argument(z.string(), { description: "who to greet" }),
    shout: argv.flag(z.boolean().default(false), { description: "uppercase the greeting" }),
  }),
  execute(_ctx, { name, shout }) {
    const text = shout ? name.toUpperCase() : name;
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

const send = defineCommand({
  summary: "Post a notification",
  input: z.object({
    message: argv.words(z.string().min(1), {
      fallbackOption: true,
      description: "notification text",
    }),
    title: argv.option(z.string().optional(), { description: "heading" }),
  }),
  execute(_ctx, { message, title }) {
    return { exitCode: 0, stdout: `${title ?? ""}:${message}\n` };
  },
});

const commands = { greet, fail, boom, send };
const program = { name: "demo", summary: "Demo CLI" };
const unusedHost = {} as CommandContext;

function invokeProgram(argvTokens: readonly string[]) {
  return runProgram(() => commandDefinitions(commands, unusedHost), argvTokens, program);
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

test("execute receives schema output; host runProgram parses argv", async () => {
  assert.deepEqual(await greet.execute(unusedHost, { name: "world", shout: false }), {
    exitCode: 0,
    stdout: "hello world\n",
  });
  assert.deepEqual(await greet.execute(unusedHost, { name: "world", shout: true }), {
    exitCode: 0,
    stdout: "hello WORLD\n",
  });
  assert.deepEqual(await invokeProgram(["greet", "world"]), {
    exitCode: 0,
    stdout: "hello world\n",
  });
  assert.deepEqual(await invokeProgram(["greet", "world", "--shout"]), {
    exitCode: 0,
    stdout: "hello WORLD\n",
  });
});

test("missing required argument: exit 2 with commander's error", async () => {
  const result = await invokeProgram(["greet"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /missing required argument/);
});

test("excess arguments: exit 2", async () => {
  const result = await invokeProgram(["greet", "a", "b"]);
  assert.equal(result.exitCode, 2);
});

test("unknown command: exit 2", async () => {
  const result = await invokeProgram(["nope"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /unknown command/);
});

test("CommandError carries its exit code, message to stderr", async () => {
  const result = await invokeProgram(["fail"]);
  assert.deepEqual(result, { exitCode: 3, stderr: "nope\n" });
});

test("CommandError defaults to exit 1", () => {
  const error = new CommandError("plain");
  assert.equal(error.exitCode, 1);
  assert.equal(error.name, "CommandError");
});

test("other throws: exit 1 with the message", async () => {
  const result = await invokeProgram(["boom"]);
  assert.deepEqual(result, { exitCode: 1, stderr: "kaboom\n" });
});

test("schema failures exit 2", async () => {
  const result = await invokeProgram(["send"]);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /invalid arguments/);
});

test("words joins rest tokens; --message is the fallback; positional wins", async () => {
  assert.deepEqual(await invokeProgram(["send", "build", "is", "done"]), {
    exitCode: 0,
    stdout: ":build is done\n",
  });
  assert.deepEqual(await invokeProgram(["send", "--message", "hi"]), {
    exitCode: 0,
    stdout: ":hi\n",
  });
  assert.deepEqual(await invokeProgram(["send", "--message=hi"]), {
    exitCode: 0,
    stdout: ":hi\n",
  });
  assert.deepEqual(await invokeProgram(["send", "positional", "--message", "flag"]), {
    exitCode: 0,
    stdout: ":positional\n",
  });
  assert.deepEqual(await invokeProgram(["send", "  hi  ", "--title", "T"]), {
    exitCode: 0,
    stdout: "T:hi\n",
  });
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
  await record.execute({ cwd: "/w", threadId: "t1", projectId: "p1" } as CommandContext);
  assert.deepEqual(seen, { cwd: "/w", threadId: "t1", projectId: "p1" });
  await record.execute({} as CommandContext);
  assert.deepEqual(seen, { cwd: undefined, threadId: undefined, projectId: undefined });
});

function typeOnly() {
  defineCommand({
    summary: "a",
    execute: (_ctx: CommandContext) => ({ exitCode: 0 }),
  });
  defineCommand({
    summary: "a",
    // @ts-expect-error a field without an argv binding is rejected
    input: z.object({
      path: z.string(),
    }),
    execute: (_ctx: CommandContext, _input: { path: string }) => ({ exitCode: 0 }),
  });
  defineCommand({
    summary: "a",
    // @ts-expect-error extra key without a binding is rejected
    input: z.object({
      path: argv.argument(z.string()),
      extra: z.string(),
    }),
    execute: (_ctx: CommandContext, _input: { path: string; extra: string }) => ({ exitCode: 0 }),
  });
  defineCommand({
    summary: "a",
    input: z.object({
      // @ts-expect-error option cannot fill a required string
      path: argv.option(z.string()),
    }),
    execute: (_ctx: CommandContext, _input: { path: string }) => ({ exitCode: 0 }),
  });
  defineCommand({
    summary: "a",
    // @ts-expect-error a command demanding a field outside CommandContext is rejected
    execute: (_ctx: { extra(): void }) => ({ exitCode: 0 }),
  });
  // @ts-expect-error with-input execute must take ctx and input
  defineCommand({
    summary: "a",
    input: z.object({
      path: argv.argument(z.string()),
    }),
    execute: (_ctx: CommandContext) => ({ exitCode: 0 }),
  });
  defineCommand({
    summary: "a",
    // @ts-expect-error no-input execute must not take a second argument
    execute: (_ctx: CommandContext, _input: { path: string }) => ({ exitCode: 0 }),
  });
  defineCommand({
    summary: "a",
    // @ts-expect-error bind then .optional() strips the argv brand
    input: z.object({
      path: argv.argument(z.string()).optional(),
    }),
    execute: (_ctx: CommandContext, _input: { path?: string }) => ({ exitCode: 0 }),
  });
}
void typeOnly;
