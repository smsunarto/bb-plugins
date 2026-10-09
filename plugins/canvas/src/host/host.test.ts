import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "./host.ts";

const host = experimental_createHostEntryHarness(hostEntry);
let scratch = "";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canvas-host-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Write `content` and date it a minute back, past any timestamp tick. */
async function settled(name: string, content: string): Promise<string> {
  const path = join(scratch, name);
  await writeFile(path, content);
  const minuteAgo = new Date(Date.now() - 60_000);
  await utimes(path, minuteAgo, minuteAgo);
  return path;
}

test("a settled file keeps its stamp until it is written again", async () => {
  const path = await settled("a.canvas.mdx", "# A\n");
  const first = await host.experimental_call("stamp", { path });
  expect(first.stamp).toBeString();
  expect(await host.experimental_call("stamp", { path })).toEqual(first);
  await settled("a.canvas.mdx", "# B\n");
  expect((await host.experimental_call("stamp", { path })).stamp).not.toBe(first.stamp);
});

test("a file written moments ago is never vouched for", async () => {
  const path = join(scratch, "fresh.canvas.mdx");
  await writeFile(path, "# Fresh\n");
  expect(await host.experimental_call("stamp", { path })).toEqual({ stamp: null });
});

test("a missing file is absent and a directory is not a file", async () => {
  expect(await host.experimental_call("stamp", { path: join(scratch, "gone.mdx") })).toEqual({
    stamp: "absent",
  });
  expect(await host.experimental_call("stamp", { path: scratch })).toEqual({ stamp: null });
});
