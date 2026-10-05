import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { EXISTS_TTL_MS, exists, forgetExists, memoizeExists } from "./fs.ts";
import { installInProcessHostIo } from "./testing/in-process.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});

/** The in-process host, counting the `exists` calls that reach it. */
function host() {
  const { client, uninstall } = installInProcessHostIo();
  cleanups.push(uninstall);
  return () =>
    client.calls.filter(
      (call) => call.method === "invoke" && (call.input as { fn: string }).fn === "exists",
    ).length;
}

test("while memoized, a root is asked once per 3 s and again after forgetExists", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const asks = host();
  cleanups.push(memoizeExists());

  expect(await exists("/repo")).toBe(false);
  vi.advanceTimersByTime(2_999);
  expect(await exists("/repo")).toBe(false);
  expect(asks()).toBe(1);

  forgetExists();
  expect(await exists("/repo")).toBe(false);
  expect(asks()).toBe(2);

  vi.advanceTimersByTime(3_000);
  await exists("/repo");
  expect(EXISTS_TTL_MS).toBe(3_000);
  expect(asks()).toBe(3);
});

test("a removed checkout reads as present until the memo expires", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  host();
  cleanups.push(memoizeExists());
  const root = mkdtempSync(path.join(tmpdir(), "whiteboard-exists-"));

  expect(await exists(root)).toBe(true);
  rmSync(root, { recursive: true });
  expect(await exists(root)).toBe(true);
  vi.advanceTimersByTime(3_000);
  expect(await exists(root)).toBe(false);
});

test("without an engine's memo every call asks the host", async () => {
  const asks = host();
  const stop = memoizeExists();
  stop();

  await exists("/repo");
  await exists("/repo");

  expect(asks()).toBe(2);
});
