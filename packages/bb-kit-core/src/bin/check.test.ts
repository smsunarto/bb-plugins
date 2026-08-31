import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCheck, isValidSemverRange } from "./check.ts";
import { runCreate } from "./create.ts";
import { UNIT_NAME_PATTERN, camelName } from "./shared.ts";

/**
 * Fixtures are real `create` scaffolds in $TMPDIR. check parses with the
 * PLUGIN'S OWN typescript and reads the plugin's own SDK policy, so both
 * are symlinked from this repo's node_modules — the symlink's real path
 * makes the plugin's `typescript` module and the SDK's imports resolve
 * there.
 */

const REPO_MODULES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "node_modules",
);

function makeFixture(name = "bb-plugin-notes", { link = true } = {}): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "bb-kit-check-")));
  const created = runCreate(name, { cwd: parent, install: () => ({ status: 0, output: "" }) });
  assert.equal(created.exitCode, 0, created.stderr);
  const dirName = name.startsWith("@") ? name.slice(name.indexOf("/") + 1) : name;
  const root = join(parent, dirName);
  mkdirSync(join(root, "node_modules", "@get-bb"), { recursive: true });
  symlinkSync(
    join(REPO_MODULES, "@get-bb", "plugin-sdk"),
    join(root, "node_modules", "@get-bb", "plugin-sdk"),
  );
  if (link) {
    symlinkSync(join(REPO_MODULES, "typescript"), join(root, "node_modules", "typescript"));
  }
  return root;
}

function edit(root: string, relative: string, from: string, to: string): void {
  const path = join(root, relative);
  const before = readFileSync(path, "utf8");
  const after = before.replace(from, to);
  assert.notEqual(after, before, `edit found nothing to replace in ${relative}`);
  writeFileSync(path, after);
}

/** A tools unit whose export is camel(base), optionally gated. */
function addToolUnit(root: string, base: string, { enabled = false } = {}): void {
  mkdirSync(join(root, "server", "tools"), { recursive: true });
  writeFileSync(
    join(root, "server", "tools", `${base}.ts`),
    [
      'import { defineTool } from "@bb-kit/core/tools";',
      'import { z } from "zod";',
      "",
      `export const ${camelName(base)} = defineTool({`,
      '  description: "d",',
      "  parameters: z.object({}),",
      ...(enabled ? ["  enabled: () => true,"] : []),
      '  execute: () => "ok",',
      "});",
      "",
    ].join("\n"),
  );
  writeFileSync(join(root, "server", "tools", `${base}.test.ts`), "export {};\n");
}

/** Import the unit into server.ts and add the given agents entry. */
function wireAgents(root: string, base: string, entry: string): void {
  edit(
    root,
    "server/server.ts",
    'import { definePlugin } from "@bb-kit/core/plugin";',
    `import { definePlugin } from "@bb-kit/core/plugin";\nimport { ${camelName(base)} } from "./tools/${base}.ts";`,
  );
  edit(
    root,
    "server/server.ts",
    "command: { status },",
    `command: { status },\n  agents: ${entry},`,
  );
}

function addManifestSkill(root: string, name: string): void {
  mkdirSync(join(root, "skills", name), { recursive: true });
  writeFileSync(join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
}

// The reserved-name test keys off the REAL host policy; when the
// installed SDK stops exporting it, the test skips instead of pinning
// a stale copy.
const requireHere = createRequire(import.meta.url);
let reservedAgentToolNames: readonly string[] | undefined;
try {
  const policyPath = requireHere.resolve("@get-bb/plugin-sdk/internal/host-policy");
  const policy = (await import(pathToFileURL(policyPath).href)) as {
    RESERVED_AGENT_TOOL_NAMES?: readonly string[];
  };
  reservedAgentToolNames = policy.RESERVED_AGENT_TOOL_NAMES;
} catch {
  reservedAgentToolNames = undefined;
}

/** A reserved name splittable into a valid plugin id + tool key. */
function reservedSplit(
  names: readonly string[],
): { name: string; prefix: string; base: string } | undefined {
  for (const name of names) {
    const sep = name.indexOf("_");
    if (sep <= 0) {
      continue;
    }
    const prefix = name.slice(0, sep);
    const key = name.slice(sep + 1);
    const base = key.replaceAll("_", "-");
    if (!/^[a-z][a-z0-9]*$/.test(prefix) || !UNIT_NAME_PATTERN.test(base)) {
      continue;
    }
    if (base.replaceAll("-", "_") !== key) {
      continue;
    }
    return { name, prefix, base };
  }
  return undefined;
}

const reservedCandidate =
  reservedAgentToolNames === undefined ? undefined : reservedSplit(reservedAgentToolNames);

test("a fresh scaffold passes with the wire table", async () => {
  const root = makeFixture();
  const result = await runCheck({ cwd: root });
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /RPC names:\n {2}ping\n/);
  assert.match(result.stdout, /check passed\n$/);
});

test("an unwired unit file breaks the bijection (rule 1)", async () => {
  const root = makeFixture();
  writeFileSync(join(root, "server", "rpc", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(root, "server", "rpc", "extra.test.ts"), "export {};\n");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /error: server\/rpc\/extra\.ts — not wired into server\/server.ts rpc — rule 1/,
  );
});

test("a bare unit specifier fails rule 1 instead of resolving as a local path", async () => {
  const root = makeFixture();
  edit(root, "server/server.ts", './rpc/ping"', 'rpc/ping"');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /imports "rpc\/ping" — a relative server\/rpc\/ unit file/);
});

test("a wrong unit export name fails rule 1", async () => {
  const root = makeFixture();
  edit(root, "server/rpc/ping.ts", "export const ping =", "export const pong =");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /server\/rpc\/ping\.ts:5 — must have exactly one value export named "ping" \(found: pong\)/,
  );
});

test("two keys wiring one unit file break the bijection (rule 1)", async () => {
  const root = makeFixture();
  edit(root, "server/server.ts", "rpc: { ping },", "rpc: { ping, pingAlias: ping },");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /RPC key "pingAlias" wires server\/rpc\/ping\.ts, which is already wired — rule 1/,
  );
});

test("a commands key that is not the unit basename fails rule 1", async () => {
  const root = makeFixture();
  edit(root, "server/server.ts", "command: { status }", "command: { stat: status }");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /commands key "stat" must equal the unit's kebab basename "status"/);
});

test("a definePlugin id that is not the derived plugin id fails rule 2", async () => {
  const root = makeFixture();
  edit(root, "server/server.ts", 'pluginId: "notes",', 'pluginId: "other",');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /plugin id "other" must equal derivePluginID.* = "notes" — rule 2/);
});

test("a manifest path that does not exist fails rule 4", async () => {
  const root = makeFixture();
  edit(root, "package.json", '"server": "./server/server.ts",', '"server": "./missing.ts",');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /bb\.server "\.\/missing\.ts" does not exist — rule 4/);
});

test("bb.host is validated as a source manifest path", async () => {
  const root = makeFixture();
  edit(
    root,
    "package.json",
    '"app": "./app/app.tsx",',
    '"app": "./app/app.tsx",\n    "host": "./missing-host.ts",',
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /bb\.host "\.\/missing-host\.ts" does not exist — rule 4/);
});

test("a root host entry warns in favor of the canonical runtime directory", async () => {
  const root = makeFixture();
  writeFileSync(join(root, "host.ts"), "export {};\n");
  edit(
    root,
    "package.json",
    '"app": "./app/app.tsx",',
    '"app": "./app/app.tsx",\n    "host": "./host.ts",',
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /bb\.host should use the canonical host\/host\.ts runtime entry/);
});

test("a plugin-level src directory warns when it hides shipped source", async () => {
  const root = makeFixture();
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "helper.ts"), "export const helper = true;\n");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /plugin-level src\/ hides runtime ownership/);
});

test("cross-runtime implementation imports warn", async () => {
  const root = makeFixture();
  mkdirSync(join(root, "host"));
  writeFileSync(join(root, "host", "host.ts"), "export {};\n");
  writeFileSync(join(root, "host", "local.ts"), "export const local = true;\n");
  edit(
    root,
    "package.json",
    '"app": "./app/app.tsx",',
    '"app": "./app/app.tsx",\n    "host": "./host/host.ts",',
  );
  edit(
    root,
    "server/server.ts",
    'import { definePlugin } from "@bb-kit/core/plugin";',
    'import { definePlugin } from "@bb-kit/core/plugin";\nimport "../host/local.ts";',
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /server\/ cannot import host\/ through "\.\.\/host\/local\.ts"/);
});

test("dynamic cross-runtime imports warn", async () => {
  const root = makeFixture();
  mkdirSync(join(root, "host"));
  writeFileSync(join(root, "host", "local.ts"), "export const local = true;\n");
  edit(
    root,
    "server/server.ts",
    'import { definePlugin } from "@bb-kit/core/plugin";',
    'import { definePlugin } from "@bb-kit/core/plugin";\nvoid import("../host/local.ts");',
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /server\/ cannot import host\/ through "\.\.\/host\/local\.ts"/);
});

test("app code cannot import the Node-only shared subtree", async () => {
  const root = makeFixture();
  mkdirSync(join(root, "shared", "node"), { recursive: true });
  writeFileSync(join(root, "shared", "node", "auth.ts"), "export const auth = true;\n");
  const appPath = join(root, "app", "app.tsx");
  writeFileSync(appPath, `import "../shared/node/auth.ts";\n${readFileSync(appPath, "utf8")}`);
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /app\/ cannot import shared-node\/ through/);
});

test("portable shared code cannot import Node builtins", async () => {
  const root = makeFixture();
  mkdirSync(join(root, "shared"));
  writeFileSync(join(root, "shared", "portable.ts"), 'import "node:fs";\n');
  const appPath = join(root, "app", "app.tsx");
  writeFileSync(appPath, `import "../shared/portable.ts";\n${readFileSync(appPath, "utf8")}`);
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(result.stderr, /shared\/ must remain browser-safe and cannot import "node:fs"/);
});

test("a reserved plugin CLI name fails rule 5", async () => {
  const root = makeFixture("bb-plugin-status");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /plugin CLI name "status" is reserved by bb — rule 5/);
});

test("a missing sibling test is a warning, not a failure (rule 6)", async () => {
  const root = makeFixture();
  rmSync(join(root, "server", "rpc", "ping.test.ts"));
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(
    result.stderr,
    /warning: server\/rpc\/ping\.ts — no sibling test server\/rpc\/ping\.test\.ts — rule 6/,
  );
  assert.match(result.stdout, /check passed with 1 warning\n$/);
});

test("a unit file the tsconfig include omits still parses via the composition root's import", async () => {
  const root = makeFixture();
  const tsconfigPath = join(root, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as Record<string, unknown>;
  tsconfig["include"] = [
    "server/server.ts",
    "server/server.test.ts",
    "server/command/**/*",
    "app/**/*",
  ];
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  const result = await runCheck({ cwd: root });
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /check passed\n$/);
});

test("an unparseable tsconfig.json is a toolchain failure, not a crash", async () => {
  const root = makeFixture();
  writeFileSync(join(root, "tsconfig.json"), "{{ broken\n");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /tsconfig\.json did not load as a TypeScript project: .* \(parse-dependent rules skipped\)/,
  );
});

test("a tsconfig config-level error (broken extends) fails check", async () => {
  const root = makeFixture();
  const tsconfigPath = join(root, "tsconfig.json");
  const tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8")) as Record<string, unknown>;
  tsconfig["extends"] = "./missing-base.json";
  writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 2)}\n`);
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /tsconfig\.json has config errors: Cannot read file/);
});

test("a missing typescript is a toolchain failure, not a crash", async () => {
  const root = makeFixture("bb-plugin-notes", { link: false });
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /could not resolve TypeScript from the plugin/);
});

test("isValidSemverRange accepts npm ranges and rejects junk", () => {
  for (const range of [
    ">=22.19.0",
    "^1.2.3",
    "~2.0",
    "1.2.x",
    "*",
    "1.0.0 - 2.0.0",
    "^1.0.0 || ^2.0.0",
    ">=1.2.3 <2.0.0",
  ]) {
    assert.ok(isValidSemverRange(range), range);
  }
  for (const range of ["not a version", ">=abc", "1.2.3.4.5"]) {
    assert.ok(!isValidSemverRange(range), range);
  }
});

test("a wired tools unit passes and the table derives the public name", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon");
  wireAgents(root, "beacon", "{ tools: { beacon } }");
  const result = await runCheck({ cwd: root });
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /RPC names:\n {2}ping\n/);
  assert.match(result.stdout, /Tool names:\n {2}notes_beacon\n/);
});

test("an agents.tools key that is not the underscored basename fails rule 1", async () => {
  const root = makeFixture();
  addToolUnit(root, "two-word");
  wireAgents(root, "two-word", "{ tools: { two_words: twoWord } }");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /agents\.tools key "two_words" must equal the unit's underscored basename "two_word" — rule 1/,
  );
});

test("a tools unit with no agents entry fails rule 5", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /server\/tools\/ has unit files but definePlugin has no agents entry — rule 5/,
  );
});

test("an unwired tools unit breaks the bijection (rule 1)", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon");
  addToolUnit(root, "extra");
  wireAgents(root, "beacon", "{ tools: { beacon } }");
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /server\/tools\/extra\.ts — not wired into server\/server\.ts agents — rule 1/,
  );
});

test("a hand .agents.configure( beside an agents entry warns (rule 5)", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon");
  wireAgents(root, "beacon", "{ tools: { beacon } }");
  edit(
    root,
    "server/server.ts",
    "});",
    "  async setup(bb) {\n    bb.agents.configure(() => ({ tools: [], skills: [] }));\n  },\n});",
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 0);
  assert.match(
    result.stderr,
    /warning: server\/server\.ts:\d+ — `\.agents\.configure\(` beside an agents entry/,
  );
});

test(
  "a derived tool name on the host's reserved list fails rule 7",
  {
    skip:
      reservedCandidate === undefined
        ? "the installed SDK exports no splittable RESERVED_AGENT_TOOL_NAMES"
        : false,
  },
  async () => {
    assert.ok(reservedCandidate);
    const root = makeFixture(`bb-plugin-${reservedCandidate.prefix}`);
    addToolUnit(root, reservedCandidate.base);
    wireAgents(
      root,
      reservedCandidate.base,
      `{ tools: { ${reservedCandidate.base.replaceAll("-", "_")}: ${camelName(reservedCandidate.base)} } }`,
    );
    const result = await runCheck({ cwd: root });
    assert.equal(result.exitCode, 1);
    assert.match(
      result.stderr,
      new RegExp(`agent tool name "${reservedCandidate.name}" is reserved by bb — rule 7`),
    );
  },
);

test("a gated tool with manifest skills and no agents.skills fails rule 7", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon", { enabled: true });
  wireAgents(root, "beacon", "{ tools: { beacon } }");
  const before = await runCheck({ cwd: root });
  assert.equal(before.stderr, "");
  assert.equal(before.exitCode, 0);
  addManifestSkill(root, "how-to");
  edit(root, "package.json", '"skills": []', '"skills": ["./skills"]');
  const failing = await runCheck({ cwd: root });
  assert.equal(failing.exitCode, 1);
  assert.match(failing.stderr, /synthesized configure sends skills: \[\]/);
  edit(
    root,
    "server/server.ts",
    "agents: { tools: { beacon } },",
    'agents: { tools: { beacon }, skills: ["how-to"] },',
  );
  const after = await runCheck({ cwd: root });
  assert.equal(after.stderr, "");
  assert.equal(after.exitCode, 0);
});

test("a static agents.skills name outside the manifest fails rule 7", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon");
  addManifestSkill(root, "how-to");
  edit(root, "package.json", '"skills": []', '"skills": ["./skills"]');
  wireAgents(root, "beacon", '{ tools: { beacon }, skills: ["nope"] }');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(
    result.stderr,
    /agents\.skills "nope" is not a skill the manifest enumerates \(how-to\)/,
  );
});

test("a duplicate agents.skills entry fails rule 7", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon");
  addManifestSkill(root, "how-to");
  edit(root, "package.json", '"skills": []', '"skills": ["./skills"]');
  wireAgents(root, "beacon", '{ tools: { beacon }, skills: ["how-to", "how-to"] }');
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /agents\.skills repeats "how-to" — rule 7/);
});

test("a function-valued agents.skills selector is skipped (rule 7)", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon", { enabled: true });
  addManifestSkill(root, "how-to");
  edit(root, "package.json", '"skills": []', '"skills": ["./skills"]');
  wireAgents(root, "beacon", "{ tools: { beacon }, skills: () => [] }");
  const result = await runCheck({ cwd: root });
  assert.equal(result.stderr, "");
  assert.equal(result.exitCode, 0);
});

test("more than 256 agents.skills entries fail rule 7", async () => {
  const root = makeFixture();
  addToolUnit(root, "beacon");
  const skills = Array.from({ length: 257 }, (_, index) => `"s${index}"`).join(", ");
  wireAgents(root, "beacon", `{ tools: { beacon }, skills: [${skills}] }`);
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /the host caps a selection at 256 ids \(rule 7\)/);
});

test("a command unit that imports commander fails", async () => {
  const root = makeFixture();
  edit(
    root,
    "server/command/status.ts",
    'import { defineCommand } from "@bb-kit/core/command";',
    'import { Command } from "commander";\nimport { defineCommand } from "@bb-kit/core/command";',
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /command units must not import commander/);
});

test("a bound field wrapped in .optional() fails", async () => {
  const root = makeFixture();
  writeFileSync(
    join(root, "server/command/status.ts"),
    [
      'import { argv, defineCommand } from "@bb-kit/core/command";',
      'import { z } from "zod";',
      'import { ping } from "../rpc/ping.ts";',
      "",
      "export const status = defineCommand({",
      '  summary: "Show plugin status",',
      "  input: z.object({",
      "    path: argv.argument(z.string()).optional(),",
      "  }),",
      "  async execute(ctx, _input) {",
      "    const result = await ping.execute(ctx);",
      "    return { exitCode: 0, stdout: `pong=${result.pong}\\n` };",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
  const result = await runCheck({ cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /argv binding must be outermost/);
});
