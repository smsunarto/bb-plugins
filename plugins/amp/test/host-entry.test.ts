// The host entry runs on every host daemon, beside the provider bridge. The
// server asks it about the thread's machine, so it must answer from the same
// places the bridge uses there.
import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.ts";
import { createFileOracleReportStore } from "../src/oracle-report-store.ts";

const saved = {
  XDG_STATE_HOME: process.env.XDG_STATE_HOME,
  AMP_CLI_PATH: process.env.AMP_CLI_PATH,
  PATH: process.env.PATH,
};
const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("oracleReport serves the report the bridge wrote on this host", async () => {
  process.env.XDG_STATE_HOME = tempDir("amp-host-state-");
  // The bridge's own store, with its default directory (src/bridge/entry.ts).
  const store = createFileOracleReportStore();
  const reportId = store.start({ task: "Why does the cache miss?" });
  assert.ok(reportId);
  store.complete(reportId, "The key includes the timestamp.", false);

  const host = experimental_createHostEntryHarness(hostEntry);
  const { report } = await host.experimental_call("oracleReport", { reportId });
  assert.deepEqual(
    report && { request: report.request, response: report.response, status: report.status },
    {
      request: "Why does the cache miss?",
      response: "The key includes the timestamp.",
      status: "completed",
    },
  );
  assert.deepEqual(
    await host.experimental_call("oracleReport", {
      reportId: "5f0c1a52-3b7e-4d2a-9c1e-2b9f6a7d8e01",
    }),
    { report: null },
  );
});

test("cliStatus names the Amp CLI this host's bridge would spawn", async () => {
  const bin = tempDir("amp-host-bin-");
  const cli = join(bin, "amp");
  writeFileSync(cli, "#!/bin/sh\n", "utf8");
  chmodSync(cli, 0o755);
  // A configured path that is not executable here gives way to the search.
  process.env.AMP_CLI_PATH = join(bin, "gone", "amp");
  process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ""}`;

  const host = experimental_createHostEntryHarness(hostEntry);
  assert.deepEqual(await host.experimental_call("cliStatus", {}), { path: cli });
});
