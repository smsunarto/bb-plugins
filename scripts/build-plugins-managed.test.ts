import { expect, test } from "bun:test";
import type { WorkspacePlugin } from "./plugin-package.ts";
import { buildManagedPlugins } from "./build-plugins-managed.ts";

test("managed plugin builds stay sequential and stop on the first failure", async () => {
  const plugins = [plugin("one"), plugin("two"), plugin("three")];
  const calls: string[] = [];
  await expect(
    buildManagedPlugins(async (entry) => {
      calls.push(entry.id);
      return entry.id === "two" ? 7 : 0;
    }, plugins),
  ).rejects.toThrow("two build exited with status 7");
  expect(calls).toEqual(["one", "two"]);
});

function plugin(id: string): WorkspacePlugin {
  return {
    id,
    directory: id,
    dir: `/tmp/${id}`,
    name: `@smsunarto/bb-plugin-${id}`,
    manifest: { name: `@smsunarto/bb-plugin-${id}` },
  };
}
