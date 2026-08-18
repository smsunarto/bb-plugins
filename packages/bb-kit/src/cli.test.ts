import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLIError, defineCommand, invokeCLI } from "./cli.ts";
import type { CLIContext } from "./cli.ts";

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
  run: (_rpc, { args, options }) => {
    const name = args[0] ?? "";
    const text = options["shout"] ? name.toUpperCase() : name;
    return { exitCode: 0, stdout: `hello ${text}\n` };
  },
});

const fail = defineCommand({
  summary: "Fail with a CLIError",
  run: () => {
    throw new CLIError("nope", { exitCode: 3 });
  },
});

const boom = defineCommand({
  summary: "Throw a plain Error",
  run: () => {
    throw new Error("kaboom");
  },
});

const commands = { greet, fail, boom };
const options = { name: "demo", summary: "Demo CLI" };

test("empty argv: exit 2 with help on stderr", async () => {
  const result = await invokeCLI(commands, {}, [], options);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /Usage: demo/);
  assert.match(result.stderr ?? "", /greet/);
  assert.equal(result.stdout, undefined);
});

test("--help: exit 0 with help on stdout, program name and summary shown", async () => {
  const result = await invokeCLI(commands, {}, ["--help"], options);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /Usage: demo/);
  assert.match(result.stdout ?? "", /Demo CLI/);
  assert.match(result.stdout ?? "", /Greet someone/);
  assert.equal(result.stderr, undefined);
});

test("help command: exit 0 with help on stdout", async () => {
  const result = await invokeCLI(commands, {}, ["help"], options);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /Usage: demo/);
});

test("subcommand --help: exit 0, inherited settings capture the output", async () => {
  const result = await invokeCLI(commands, {}, ["greet", "--help"], options);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout ?? "", /who to greet/);
});

test("a run result flows through, args and options are plumbed", async () => {
  assert.deepEqual(await invokeCLI(commands, {}, ["greet", "world"], options), {
    exitCode: 0,
    stdout: "hello world\n",
  });
  assert.deepEqual(await invokeCLI(commands, {}, ["greet", "world", "--shout"], options), {
    exitCode: 0,
    stdout: "hello WORLD\n",
  });
});

test("missing required argument: exit 2 with commander's error", async () => {
  const result = await invokeCLI(commands, {}, ["greet"], options);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /missing required argument/);
});

test("excess arguments: exit 2", async () => {
  const result = await invokeCLI(commands, {}, ["greet", "a", "b"], options);
  assert.equal(result.exitCode, 2);
});

test("unknown command: exit 2", async () => {
  const result = await invokeCLI(commands, {}, ["nope"], options);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr ?? "", /unknown command/);
});

test("CLIError carries its exit code, message to stderr", async () => {
  const result = await invokeCLI(commands, {}, ["fail"], options);
  assert.deepEqual(result, { exitCode: 3, stderr: "nope\n" });
});

test("CLIError defaults to exit 1", () => {
  const error = new CLIError("plain");
  assert.equal(error.exitCode, 1);
  assert.equal(error.name, "CLIError");
});

test("other throws: exit 1 with the message", async () => {
  const result = await invokeCLI(commands, {}, ["boom"], options);
  assert.deepEqual(result, { exitCode: 1, stderr: "kaboom\n" });
});

test("context reaches the command; default is {}", async () => {
  let seen: CLIContext | undefined;
  const record = defineCommand({
    summary: "Record the context",
    run: (_rpc, { context }) => {
      seen = context;
      return { exitCode: 0 };
    },
  });
  const cliContext: CLIContext = { cwd: "/w", threadId: "t1", projectId: "p1" };
  await invokeCLI({ record }, {}, ["record"], { context: cliContext });
  assert.equal(seen, cliContext);
  await invokeCLI({ record }, {}, ["record"], {});
  assert.deepEqual(seen, {});
});

test("dependencies reach the command as the first run argument", async () => {
  const needsDb = defineCommand({
    summary: "Uses a db",
    run: (rpc: { db: string }) => ({ exitCode: 0, stdout: `${rpc.db}\n` }),
  });
  const needsFs = defineCommand({
    summary: "Uses an fs",
    run: (rpc: { fs: number }) => ({ exitCode: 0, stdout: `${rpc.fs}\n` }),
  });
  const deps = { db: "postgres", fs: 7 };
  const result = await invokeCLI({ needsDb, needsFs }, deps, ["needsDb"], {});
  assert.deepEqual(result, { exitCode: 0, stdout: "postgres\n" });
});

function typeOnly() {
  const needsDb = defineCommand({
    summary: "a",
    run: (_rpc: { db: string }) => ({ exitCode: 0 }),
  });
  const needsFs = defineCommand({
    summary: "b",
    run: (_rpc: { fs: number }) => ({ exitCode: 0 }),
  });
  // @ts-expect-error deps must satisfy the intersection of every command's demand
  void invokeCLI({ a: needsDb, b: needsFs }, { db: "x" }, []);
  void invokeCLI({ a: needsDb, b: needsFs }, { db: "x", fs: 1 }, []);
}
void typeOnly;
