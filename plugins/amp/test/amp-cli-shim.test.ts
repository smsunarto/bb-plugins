import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createUserMessage, execute } from "@ampcode/sdk";
import {
  AMP_CLI_SHIM_FAST_ENV,
  AMP_CLI_SHIM_REAL_CLI_ENV,
  buildAmpCliInvocation,
} from "../src/amp-cli-shim.ts";

const REAL_CLI = "/opt/amp/bin/amp";
const BUILT_SHIM = join(
  dirname(dirname(fileURLToPath(import.meta.url))),
  "dist",
  "amp-cli-shim.js",
);

function env(fast = false): NodeJS.ProcessEnv {
  return {
    KEEP_ME: "yes",
    [AMP_CLI_SHIM_REAL_CLI_ENV]: REAL_CLI,
    ...(fast ? { [AMP_CLI_SHIM_FAST_ENV]: "1" } : {}),
  };
}

test("injects --fast into marked local SDK executions", () => {
  const invocation = buildAmpCliInvocation(["--execute", "--stream-json"], env(true));

  assert.equal(invocation.command, REAL_CLI);
  assert.deepEqual(invocation.args, ["--fast", "--execute", "--stream-json"]);
  assert.equal(invocation.env.KEEP_ME, "yes");
  assert.equal(invocation.env[AMP_CLI_SHIM_FAST_ENV], undefined);
  assert.equal(invocation.env[AMP_CLI_SHIM_REAL_CLI_ENV], undefined);
  assert.equal(invocation.env.AMP_CLI_PATH, REAL_CLI);
});

test("leaves probes, standard executions, Orb, and existing Fast flags unchanged", () => {
  for (const [args, sourceEnv] of [
    [["--version"], env(true)],
    [["--execute", "--stream-json"], env(false)],
    [["threads", "continue", "T-test", "--execute"], env(true)],
    [["--execute", "--orb-execute"], env(true)],
    [["--fast", "--execute"], env(true)],
    [["--features", "fast", "--execute"], env(true)],
  ] as const) {
    const invocation = buildAmpCliInvocation(args, sourceEnv);
    assert.deepEqual(invocation.args, args);
  }
});

test("preserves the SDK's node-script CLI handling", () => {
  const invocation = buildAmpCliInvocation(["--version"], {
    [AMP_CLI_SHIM_REAL_CLI_ENV]: "/tmp/amp.mjs",
  });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ["/tmp/amp.mjs", "--version"]);
});

test("rejects a missing real Amp CLI path", () => {
  assert.throws(
    () => buildAmpCliInvocation(["--version"], {}),
    new RegExp(AMP_CLI_SHIM_REAL_CLI_ENV),
  );
});

test("the official SDK preserves Amp steering input", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-sdk-steering-"));
  const fakeCli = join(root, "amp.mjs");
  const capture = join(root, "capture.json");
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("0.0.9999999999");
  process.exit(0);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
writeFileSync(process.env.CAPTURE_PATH, input);
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
`,
  );
  chmodSync(fakeCli, 0o755);

  const previous = {
    ampCliPath: process.env.AMP_CLI_PATH,
    capture: process.env.CAPTURE_PATH,
  };
  process.env.AMP_CLI_PATH = fakeCli;
  process.env.CAPTURE_PATH = capture;
  try {
    const prompt = (async function* () {
      yield { ...createUserMessage("change direction"), steer: true as const };
    })();
    for await (const _message of execute({ prompt })) {
    }

    const captured = JSON.parse(readFileSync(capture, "utf8"));
    assert.equal(captured.steer, true);
    assert.equal(captured.message.content[0].text, "change direction");
  } finally {
    if (previous.ampCliPath === undefined) delete process.env.AMP_CLI_PATH;
    else process.env.AMP_CLI_PATH = previous.ampCliPath;
    if (previous.capture === undefined) delete process.env.CAPTURE_PATH;
    else process.env.CAPTURE_PATH = previous.capture;
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "the official SDK reaches the built shim and adds --fast",
  { skip: !existsSync(BUILT_SHIM) && "dist/amp-cli-shim.js is not built" },
  async () => {
    const root = mkdtempSync(join(tmpdir(), "amp-cli-shim-"));
    const fakeCli = join(root, "amp.mjs");
    const capture = join(root, "capture.json");
    writeFileSync(
      fakeCli,
      `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("0.0.9999999999");
  process.exit(0);
}
for await (const _chunk of process.stdin) {}
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  fast: process.env.${AMP_CLI_SHIM_FAST_ENV},
  realCli: process.env.${AMP_CLI_SHIM_REAL_CLI_ENV},
}));
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false }));
`,
    );
    chmodSync(fakeCli, 0o755);

    const previous = {
      ampCliPath: process.env.AMP_CLI_PATH,
      realCli: process.env[AMP_CLI_SHIM_REAL_CLI_ENV],
      capture: process.env.CAPTURE_PATH,
    };
    process.env.AMP_CLI_PATH = BUILT_SHIM;
    process.env[AMP_CLI_SHIM_REAL_CLI_ENV] = fakeCli;
    process.env.CAPTURE_PATH = capture;
    try {
      for await (const _message of execute({
        prompt: "test",
        options: { env: { [AMP_CLI_SHIM_FAST_ENV]: "1" } },
      })) {
      }

      const captured = JSON.parse(readFileSync(capture, "utf8"));
      assert.deepEqual(captured.args, ["--fast", "--execute", "--stream-json", "--mode", "medium"]);
      assert.equal(captured.fast, undefined);
      assert.equal(captured.realCli, undefined);
    } finally {
      if (previous.ampCliPath === undefined) delete process.env.AMP_CLI_PATH;
      else process.env.AMP_CLI_PATH = previous.ampCliPath;
      if (previous.realCli === undefined) {
        delete process.env[AMP_CLI_SHIM_REAL_CLI_ENV];
      } else {
        process.env[AMP_CLI_SHIM_REAL_CLI_ENV] = previous.realCli;
      }
      if (previous.capture === undefined) delete process.env.CAPTURE_PATH;
      else process.env.CAPTURE_PATH = previous.capture;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
