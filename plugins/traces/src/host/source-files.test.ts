import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import {
  experimental_createHostEntryHarness,
  type ExperimentalCreateHostEntryHarnessOptions,
} from "@get-bb/plugin-sdk/testing/host";
import { fixtureJsonl, fixtureRecords } from "../../test/fixtures.ts";
import { createTraceHost } from "./host.ts";
import { TraceIndex } from "./index.ts";

type Watch = NonNullable<ExperimentalCreateHostEntryHarnessOptions["experimental_watch"]>;

for (const provider of ["codex", "claude-code"] as const) {
  test(`${provider}: a configured JSONL file indexes initially and after watcher-triggered append`, async (context) => {
    const directory = await mkdtemp(join(tmpdir(), "bb-traces-file-source-"));
    const path = join(directory, "selected.jsonl");
    const records = fixtureRecords(provider);
    await writeFile(path, `${JSON.stringify(records[0])}\n`);
    await writeFile(join(directory, "unselected.jsonl"), fixtureJsonl(provider));
    let listener: Parameters<Watch>[1] | undefined;
    const watch = context.mock.fn<Watch>(async (_options, receive) => {
      listener = receive;
      return {
        dispose: async () => {
          await setTimeout(5);
        },
      };
    });
    const host = experimental_createHostEntryHarness(createTraceHost(), {
      experimental_paths: { dataDir: join(directory, "index"), tempDir: directory },
      experimental_watch: watch,
    });
    context.after(async () => {
      await host.experimental_dispose();
      assert.equal(host.experimental_getRetainedWorkerLeaseCount(), 0);
      await rm(directory, { recursive: true, force: true });
    });
    const waitForScan = async (expectedWatches = 1) => {
      for (let attempt = 0; attempt < 1000; attempt += 1) {
        const status = await host.experimental_call("status", {});
        if (!status.scanning && listener && watch.mock.callCount() >= expectedWatches)
          return status;
        await setTimeout(2);
      }
      assert.fail("The host did not finish indexing the configured file.");
    };
    await host.experimental_call("configureSources", {
      roots: [{ provider, path, enabled: true }],
    });
    const initialStatus = await waitForScan();
    assert.equal(initialStatus.roots[0]!.state, "ready");
    assert.equal(initialStatus.roots[0]!.fileCount, 1);
    assert.equal(initialStatus.sessions, 1);
    assert.equal(host.experimental_getRetainedWorkerLeaseCount(), 1);
    assert.equal(watch.mock.calls[0]!.arguments[0].rootPath, directory);
    const session = (await host.experimental_call("sessions", {})).items[0]!;
    assert.equal(session.path, path);
    const initial = await host.experimental_call("events", { sessionId: session.id });
    assert.ok(initial.items.length > 0);
    assert.ok(listener);
    await listener({ kind: "changed", changes: [{ path: "unselected.jsonl", type: "update" }] });
    assert.equal((await host.experimental_call("status", {})).scanning, false);
    await appendFile(path, `${JSON.stringify(records[1])}\n`);
    await listener({ kind: "changed", changes: [{ path, type: "update" }] });
    const appendedStatus = await waitForScan();
    assert.equal(appendedStatus.roots[0]!.state, "ready");
    assert.equal(appendedStatus.sessions, 1);
    const appended = await host.experimental_call("events", { sessionId: session.id });
    assert.ok(appended.items.length > initial.items.length);
    assert.equal(appended.items[0]!.id, initial.items[0]!.id);
    const event = appended.items.at(-1)!;
    const raw = await host.experimental_call("raw", { eventId: event.id });
    const bytes = await readFile(path);
    assert.deepEqual(
      Buffer.from(raw.base64, "base64"),
      bytes.subarray(event.provenance.byteOffset),
    );
  });
}

test("a configured unsupported file reports an error instead of indexing sibling files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "bb-traces-file-source-"));
  const path = join(directory, "unsupported.txt");
  await writeFile(path, fixtureJsonl("codex"));
  await writeFile(join(directory, "unselected.jsonl"), fixtureJsonl("codex"));
  const index = new TraceIndex({
    dataDir: join(directory, "index"),
    roots: [{ provider: "codex", path, enabled: true }],
  });
  context.after(async () => {
    await index.close();
    await rm(directory, { recursive: true, force: true });
  });
  await index.scan();
  const status = index.status();
  assert.equal(status.roots[0]!.state, "error");
  assert.match(status.roots[0]!.message!, /not supported/);
  assert.equal(status.sessions, 0);
});
