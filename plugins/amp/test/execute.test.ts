import assert from "node:assert/strict";
import { test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseUnsupportedFlag } from "../src/bridge/events.ts";
import {
  buildAmpArgv,
  buildAmpSettings,
  createAmpExecute,
  createUserMessage,
  optionForFlag,
  type AmpUserInputMessage,
} from "../src/bridge/execute.ts";

test("buildAmpArgv emits the bare execute wire by default", () => {
  assert.deepEqual(buildAmpArgv({}), ["--execute", "--stream-json"]);
});

test("buildAmpArgv adds --stream-json-input for framed stdin", () => {
  assert.deepEqual(buildAmpArgv({}, {}, true), [
    "--execute",
    "--stream-json",
    "--stream-json-input",
  ]);
  assert.deepEqual(buildAmpArgv({ thinking: true }, {}, true), [
    "--execute",
    "--stream-json-thinking",
    "--stream-json-input",
  ]);
});

test("buildAmpArgv orders every local flag the conversation can set", () => {
  const argv = buildAmpArgv(
    {
      continue: "T-123",
      fast: true,
      thinking: true,
      dangerouslyAllowAll: true,
      noArchiveAfterExecute: true,
      mode: "medium",
      labels: ["bb", "acp"],
    },
    { settingsFile: "/tmp/s.json", mcpConfigFile: "/tmp/m.json" },
  );
  assert.deepEqual(argv, [
    "threads",
    "continue",
    "T-123",
    "--fast",
    "--execute",
    "--stream-json-thinking",
    "--dangerously-allow-all",
    "--no-archive-after-execute",
    "--settings-file",
    "/tmp/s.json",
    "--mcp-config",
    "/tmp/m.json",
    "--mode",
    "medium",
    "--label",
    "bb",
    "--label",
    "acp",
  ]);
});

test("buildAmpArgv carries the fast+mode sequence the shim used to splice", () => {
  assert.deepEqual(buildAmpArgv({ fast: true, mode: "medium" }), [
    "--fast",
    "--execute",
    "--stream-json",
    "--mode",
    "medium",
  ]);
});

test("buildAmpArgv builds the orb wire", () => {
  assert.deepEqual(buildAmpArgv({ executor: "orb", project: "my-project", thinking: true, mode: "high" }), [
    "--execute",
    "--stream-json-thinking",
    "--orb-execute",
    "--project",
    "my-project",
    "--mode",
    "high",
  ]);
});

test("every optional flag the builder can emit maps back to an option for the drop-retry", () => {
  const emitted = [
    ...buildAmpArgv(
      {
        continue: "T-1",
        fast: true,
        thinking: true,
        dangerouslyAllowAll: true,
        noArchiveAfterExecute: true,
        mode: "medium",
        labels: ["x"],
      },
      { settingsFile: "/s", mcpConfigFile: "/m" },
    ),
    ...buildAmpArgv({ executor: "orb", project: "p" }),
    ...buildAmpArgv({}, {}, true),
  ];
  const undroppable = new Set([
    "execute",
    "stream-json",
    "stream-json-input",
    "orb-execute",
    "project",
    "settings-file",
  ]);
  for (const arg of emitted) {
    if (!arg.startsWith("--")) continue;
    const flag = arg.slice(2);
    if (undroppable.has(flag)) continue;
    assert.notEqual(optionForFlag(flag), null, `--${flag} has no drop-retry mapping`);
  }
});

test("optionForFlag maps the wire names and fails closed on the rest", () => {
  assert.equal(optionForFlag("label"), "labels");
  assert.equal(optionForFlag("mcp-config"), "mcpConfig");
  assert.equal(optionForFlag("stream-json-thinking"), "thinking");
  assert.equal(optionForFlag("fast"), "fast");
  // Emitted only when the option is true, so the drop can only remove
  // permission, never grant it.
  assert.equal(optionForFlag("dangerously-allow-all"), "dangerouslyAllowAll");
  // Orb must fail, not silently run locally, on a CLI without --orb-execute.
  assert.equal(optionForFlag("orb-execute"), null);
  // Dropping these two would change the blast radius, not a preference: the
  // settings file carries the explicit dangerouslyAllowAll:false override,
  // and --project overrides git-remote inference of the Orb repository.
  assert.equal(optionForFlag("settings-file"), null);
  assert.equal(optionForFlag("project"), null);
  // The retired SDK-era mapping carried a dead effort entry; it stays dead.
  assert.equal(optionForFlag("effort"), null);
  // Framed stdin is the wire itself; a CLI rejecting it must error, not retry.
  assert.equal(optionForFlag("stream-json-input"), null);
  assert.equal(optionForFlag("definitely-not-a-flag"), null);
});

test("createUserMessage builds the stream-json user line", () => {
  assert.deepEqual(createUserMessage("hello"), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  });
});

test("buildAmpSettings merges the plugin-controlled keys over the user base", () => {
  const configHome = mkdtempSync(join(tmpdir(), "amp-settings-"));
  mkdirSync(join(configHome, "amp"), { recursive: true });
  writeFileSync(
    join(configHome, "amp", "settings.json"),
    JSON.stringify({ "amp.url": "https://ampcode.com", "amp.dangerouslyAllowAll": true }),
  );
  const settings = buildAmpSettings(
    { permissions: [{ tool: "Bash", action: "reject" }], dangerouslyAllowAll: false },
    { AMP_SETTINGS_FILE: "", XDG_CONFIG_HOME: configHome },
  );
  assert.deepEqual(settings, {
    "amp.url": "https://ampcode.com",
    "amp.permissions": [{ tool: "Bash", action: "reject" }],
    "amp.dangerouslyAllowAll": false,
  });
});

test("buildAmpSettings prefers AMP_SETTINGS_FILE and fails loudly when it is broken", () => {
  const root = mkdtempSync(join(tmpdir(), "amp-settings-"));
  const explicit = join(root, "explicit.json");
  writeFileSync(explicit, JSON.stringify({ "amp.url": "https://explicit" }));
  const settings = buildAmpSettings(
    { dangerouslyAllowAll: true },
    { AMP_SETTINGS_FILE: explicit, XDG_CONFIG_HOME: root },
  );
  assert.deepEqual(settings, { "amp.url": "https://explicit", "amp.dangerouslyAllowAll": true });

  const broken = join(root, "broken.json");
  writeFileSync(broken, "{ not json");
  assert.throws(() => buildAmpSettings({ dangerouslyAllowAll: true }, { AMP_SETTINGS_FILE: broken }));
});

test("buildAmpSettings skips an unparseable settings.jsonc and prefers settings.json", () => {
  const configHome = mkdtempSync(join(tmpdir(), "amp-settings-"));
  mkdirSync(join(configHome, "amp"), { recursive: true });
  writeFileSync(join(configHome, "amp", "settings.jsonc"), "// jsonc comment\n{ \"amp.a\": 1 }");
  const jsoncSkipped = buildAmpSettings({ dangerouslyAllowAll: true }, { XDG_CONFIG_HOME: configHome });
  assert.deepEqual(jsoncSkipped, { "amp.dangerouslyAllowAll": true });

  writeFileSync(join(configHome, "amp", "settings.jsonc"), JSON.stringify({ "amp.b": 2 }));
  writeFileSync(join(configHome, "amp", "settings.json"), JSON.stringify({ "amp.a": 1 }));
  const jsonWins = buildAmpSettings({}, { XDG_CONFIG_HOME: configHome });
  assert.deepEqual(jsonWins, { "amp.a": 1 });
});

// ---------------------------------------------------------------------------
// Integration through a fake Amp CLI. The script is deliberately not
// executable and has no shebang: spawning it succeeds only through the
// node-script wrap.
// ---------------------------------------------------------------------------

const FAKE_CLI = `
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
const argv = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const fileJson = (flag) => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : JSON.parse(readFileSync(argv[at + 1], "utf8"));
};
out({
  type: "argv",
  argv,
  settings: fileJson("--settings-file"),
  mcp: fileJson("--mcp-config"),
  settingsPath: argv.includes("--settings-file") ? argv[argv.indexOf("--settings-file") + 1] : null,
  probe: process.env.FAKE_PROBE ?? null,
});
if (process.env.FAKE_STDERR) {
  process.stderr.write(process.env.FAKE_STDERR);
  process.exit(Number(process.env.FAKE_EXIT ?? "1"));
}
if (process.env.FAKE_GARBAGE) process.stdout.write("definitely not json\\n");
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    message = { raw: line };
  }
  out({ type: "echo", message });
});
rl.on("close", () => process.exit(0));
`;

interface FakeHead {
  type: string;
  argv: string[];
  settings: Record<string, unknown> | null;
  mcp: Record<string, unknown> | null;
  settingsPath: string | null;
  probe: string | null;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amp-execute-"));
  const cli = join(root, "fake-amp.mjs");
  writeFileSync(cli, FAKE_CLI, "utf8");
  const configHome = join(root, "config");
  mkdirSync(join(configHome, "amp"), { recursive: true });
  return {
    root,
    configHome,
    // Pin the settings lookup away from the real machine's Amp config.
    env: { AMP_SETTINGS_FILE: "", XDG_CONFIG_HOME: configHome },
    execute: createAmpExecute({ cliPath: cli }),
  };
}

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

test("createAmpExecute spawns the CLI with the built argv, merged settings, and mcp config", async () => {
  const f = fixture();
  writeFileSync(
    join(f.configHome, "amp", "settings.json"),
    JSON.stringify({ "amp.url": "https://ampcode.com" }),
  );
  const mcpConfig = {
    "bb-bridge": { command: "node", args: ["proxy.js"], env: { PORT: "1" } },
  };
  const messages = await collect(
    f.execute({
      prompt: "hello amp",
      options: {
        mode: "medium",
        thinking: true,
        dangerouslyAllowAll: false,
        permissions: [{ tool: "Bash", action: "reject" }],
        labels: ["bb"],
        mcpConfig,
        env: { ...f.env, FAKE_PROBE: "reached" },
      },
    }),
  );
  assert.equal(messages.length, 2);
  const head = messages[0] as FakeHead;
  assert.equal(head.type, "argv");
  assert.deepEqual(head.argv.slice(0, 2), ["--execute", "--stream-json-thinking"]);
  assert.equal(head.argv[2], "--settings-file");
  assert.equal(head.argv[4], "--mcp-config");
  assert.deepEqual(head.argv.slice(6), ["--mode", "medium", "--label", "bb"]);
  assert.deepEqual(head.settings, {
    "amp.url": "https://ampcode.com",
    "amp.permissions": [{ tool: "Bash", action: "reject" }],
    "amp.dangerouslyAllowAll": false,
  });
  assert.deepEqual(head.mcp, mcpConfig);
  assert.equal(head.probe, "reached");
  assert.deepEqual(messages[1], { type: "echo", message: { raw: "hello amp" } });
  // The settings temp dir is gone once the run completes.
  assert.equal(head.settingsPath === null || existsSync(head.settingsPath), false);
});

test("steering messages reach the CLI stdin verbatim, steer flag included", async () => {
  const f = fixture();
  async function* input(): AsyncIterable<AmpUserInputMessage> {
    yield createUserMessage("first");
    yield { ...createUserMessage("second"), steer: true };
  }
  const messages = await collect(f.execute({ prompt: input(), options: { env: f.env } }));
  // A framed prompt must announce itself, or real amp reads stdin as raw
  // text until EOF and times out against the held-open steering stdin.
  assert.ok((messages[0] as FakeHead).argv.includes("--stream-json-input"));
  const echoes = messages.filter(
    (m): m is { type: "echo"; message: AmpUserInputMessage } =>
      typeof m === "object" && m !== null && (m as { type?: string }).type === "echo",
  );
  assert.equal(echoes.length, 2);
  assert.equal(echoes[0]!.message.steer, undefined);
  assert.equal(echoes[1]!.message.steer, true);
  assert.deepEqual(echoes[1]!.message.message.content, [{ type: "text", text: "second" }]);
});

test("non-JSON stdout lines are skipped, not fatal", async () => {
  const f = fixture();
  const messages = await collect(
    f.execute({ prompt: "x", options: { env: { ...f.env, FAKE_GARBAGE: "1" } } }),
  );
  assert.deepEqual(
    messages.map((m) => (m as { type: string }).type),
    ["argv", "echo"],
  );
});

test("a nonzero exit surfaces the CLI stderr for the unsupported-flag retry", async () => {
  const f = fixture();
  await assert.rejects(
    collect(
      f.execute({
        prompt: "x",
        options: {
          mode: "medium",
          env: { ...f.env, FAKE_STDERR: "error: unknown option '--mode'\n", FAKE_EXIT: "2" },
        },
      }),
    ),
    (error: Error) => {
      assert.match(error.message, /exited with code 2/);
      assert.match(error.message, /unknown option '--mode'/);
      assert.equal(parseUnsupportedFlag(error.message), "mode");
      return true;
    },
  );
});

test("an already-aborted signal refuses to spawn", async () => {
  const f = fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    collect(f.execute({ prompt: "x", signal: controller.signal, options: { env: f.env } })),
  );
});

test("aborting mid-run terminates the CLI", async () => {
  const f = fixture();
  const controller = new AbortController();
  async function* input(): AsyncIterable<AmpUserInputMessage> {
    yield createUserMessage("first");
    await new Promise((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(undefined));
    });
  }
  const run = f.execute({ prompt: input(), signal: controller.signal, options: { env: f.env } });
  const iterator = run[Symbol.asyncIterator]();
  const head = await iterator.next();
  assert.equal((head.value as { type: string }).type, "argv");
  controller.abort();
  await assert.rejects(
    (async () => {
      for (;;) {
        const step = await iterator.next();
        if (step.done) return;
      }
    })(),
  );
});

test("mcpConfig with the orb executor fails fast", async () => {
  const f = fixture();
  await assert.rejects(
    collect(
      f.execute({
        prompt: "x",
        options: { executor: "orb", mcpConfig: { s: { command: "node" } }, env: f.env },
      }),
    ),
    /Orb/,
  );
});
