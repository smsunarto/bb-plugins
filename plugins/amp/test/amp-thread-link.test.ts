import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  archiveAmpThread,
  buildSessionLinkCommandArgs,
  currentAmpThreadId,
  mergeAmpThreadLinkRecord,
  parseAmpThreadLinkRecord,
  parseSessionLinkReport,
} from "../src/amp-thread-link.ts";

test("serializes Local and Orb links for the private bb CLI command", () => {
  assert.deepEqual(buildSessionLinkCommandArgs({
    sessionId: "S-local",
    executionTarget: "local",
    ampThreadId: "T-local",
  }), ["amp", "link-session", "S-local", "local", "T-local"]);
  assert.deepEqual(buildSessionLinkCommandArgs({
    sessionId: "S-orb",
    executionTarget: "orb",
    ampThreadId: null,
  }), ["amp", "link-session", "S-orb", "orb"]);
});

test("parses Local and Orb reports into thread links and Orb usage", () => {
  assert.deepEqual(parseSessionLinkReport([
    "link-session",
    "S-local",
    "local",
  ]), {
    providerSessionId: "S-local",
    ampThreadId: null,
    usage: { providerSessionId: "S-local", state: "local" },
  });
  assert.deepEqual(parseSessionLinkReport([
    "link-session",
    "S-local",
    "local",
    "T-local",
  ]), {
    providerSessionId: "S-local",
    ampThreadId: "T-local",
    usage: { providerSessionId: "S-local", state: "local" },
  });
  assert.deepEqual(parseSessionLinkReport([
    "link-session",
    "S-orb",
    "orb",
    "T-orb",
  ]), {
    providerSessionId: "S-orb",
    ampThreadId: "T-orb",
    usage: {
      providerSessionId: "S-orb",
      state: "orb-active",
      ampThreadId: "T-orb",
    },
  });
});

test("rejects malformed reports and stored links", () => {
  for (const argv of [
    ["link-session", "bad/session", "local"],
    ["link-session", "S-local", "remote"],
    ["link-session", "S-local", "local", "bad-thread"],
    ["link-session", "S-local", "local", "T-valid", "extra"],
  ]) {
    assert.equal(parseSessionLinkReport(argv), null);
  }
  assert.equal(parseAmpThreadLinkRecord({
    providerSessionId: "S-local",
    ampThreadId: "T-valid",
    extra: true,
  }), null);
});

test("a late report cannot erase or replace a provider session's Amp thread", () => {
  const linked = { providerSessionId: "S-one", ampThreadId: "T-one" };
  assert.equal(
    mergeAmpThreadLinkRecord(linked, {
      providerSessionId: "S-one",
      ampThreadId: null,
    }),
    linked,
  );
  assert.equal(
    mergeAmpThreadLinkRecord(linked, {
      providerSessionId: "S-one",
      ampThreadId: "T-other",
    }),
    linked,
  );
  const report = {
    providerSessionId: "S-two",
    ampThreadId: null,
    usage: { providerSessionId: "S-two", state: "local" },
  };
  const replacement = mergeAmpThreadLinkRecord(linked, report);
  assert.deepEqual(
    replacement,
    { providerSessionId: "S-two", ampThreadId: null },
  );
  assert.deepEqual(
    parseAmpThreadLinkRecord(replacement),
    replacement,
  );
});

test("selects only the current provider session and falls back to legacy Orb usage", () => {
  assert.equal(currentAmpThreadId(
    "S-current",
    { providerSessionId: "S-current", ampThreadId: "T-local" },
    null,
  ), "T-local");
  assert.equal(currentAmpThreadId(
    "S-current",
    { providerSessionId: "S-current", ampThreadId: null },
    {
      providerSessionId: "S-current",
      state: "orb-active",
      ampThreadId: "T-legacy-orb",
    },
  ), "T-legacy-orb");
  assert.equal(currentAmpThreadId(
    "S-current",
    { providerSessionId: "S-stale", ampThreadId: "T-stale" },
    {
      providerSessionId: "S-stale",
      state: "orb-active",
      ampThreadId: "T-stale",
    },
  ), null);
});

test("archives the exact linked thread with the provider environment", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-archive-"));
  const cli = join(root, "amp.mjs");
  const capture = join(root, "capture.json");
  writeFileSync(cli, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  apiKey: process.env.AMP_API_KEY,
  ci: process.env.CI,
  term: process.env.TERM,
  electron: process.env.ELECTRON_RUN_AS_NODE ?? null,
}));
`);
  chmodSync(cli, 0o755);

  try {
    await archiveAmpThread(cli, "T-linked", {
      ...process.env,
      CAPTURE_PATH: capture,
      AMP_API_KEY: "test-key",
      ELECTRON_RUN_AS_NODE: "1",
    });
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), {
      args: ["threads", "archive", "T-linked"],
      apiKey: "test-key",
      ci: "1",
      term: "dumb",
      electron: null,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports Amp CLI archive failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "amp-archive-fail-"));
  const cli = join(root, "amp.mjs");
  writeFileSync(cli, `#!/usr/bin/env node
console.error("archive denied");
process.exit(7);
`);
  chmodSync(cli, 0o755);

  try {
    await assert.rejects(
      archiveAmpThread(cli, "T-linked", process.env),
      /Could not archive Amp thread T-linked: archive denied/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
