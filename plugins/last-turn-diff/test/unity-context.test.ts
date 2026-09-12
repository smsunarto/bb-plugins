import { expect, mock, test } from "bun:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { addUnityContext, recordedUnityDiff } from "../src/server/lib/unity-context.ts";
const current = "--- !u!1 &1\nGameObject:\n  m_Name: Player\n  m_IsActive: 0\n";
const patch =
  "diff --git a/Hero.prefab b/Hero.prefab\n--- a/Hero.prefab\n+++ b/Hero.prefab\n@@ -3,2 +3,2 @@\n   m_Name: Player\n-  m_IsActive: 1\n+  m_IsActive: 0\n";
function host(content = current) {
  const read = mock(async () => ({ contentEncoding: "utf8", content }));
  const bb = {
    sdk: {
      threads: { get: async () => ({ environmentId: "e" }) },
      environments: { get: async () => ({ hostId: "h", path: "/workspace" }) },
      files: { read },
    },
  } as unknown as BbPluginApi;
  return { bb, read };
}
const turn = { turnId: "t", anchorId: "a", patch, changes: [], limited: false };
test("Last Turn reconstructs only recorded values and fences workspace context reads", async () => {
  const { bb, read } = host();
  const result = await addUnityContext(bb, "thread", turn);
  expect(result.patch).toBe(patch);
  expect(result.unity?.["0"]?.groups[0]).toMatchObject({
    name: "Player",
    components: [{ properties: [{ path: "m_IsActive", before: "1", after: "0" }] }],
  });
  expect(read).toHaveBeenCalledWith({
    hostId: "h",
    path: "/workspace/Hero.prefab",
    rootPath: "/workspace",
  });
});
test("mismatched, missing and malformed context keep the original turn patch", async () => {
  for (const content of [
    current.replace("m_IsActive: 0", "m_IsActive: 7"),
    "not unity",
    "--- !u!1 &1\nGameObject: [bad",
  ]) {
    const { bb } = host(content);
    expect(await addUnityContext(bb, "thread", turn)).toEqual(turn);
  }
  const { bb, read } = host();
  read.mockRejectedValue(new Error("missing"));
  expect(await addUnityContext(bb, "thread", turn)).toEqual(turn);
});
test("new and deleted Unity assets need no current file and preserve null sides", () => {
  const added =
    "--- /dev/null\n+++ b/Hero.prefab\n@@ -0,0 +1,4 @@\n" +
    current
      .trimEnd()
      .split("\n")
      .map((line) => "+" + line)
      .join("\n") +
    "\n";
  const deleted =
    "--- a/Hero.prefab\n+++ /dev/null\n@@ -1,4 +0,0 @@\n" +
    current
      .trimEnd()
      .split("\n")
      .map((line) => "-" + line)
      .join("\n") +
    "\n";
  expect(recordedUnityDiff(added, "").groups[0]?.status).toBe("added");
  expect(recordedUnityDiff(deleted, "").groups[0]?.status).toBe("removed");
});
test("escaping recorded paths and non-Unity changes cause no file reads", async () => {
  for (const path of ["../Hero.prefab", "/Hero.prefab", "src/a.ts"]) {
    const { bb, read } = host();
    await addUnityContext(bb, "thread", {
      ...turn,
      patch: null,
      changes: [{ id: "c", path, patch, added: 1, removed: 1 }],
    });
    expect(read).not.toHaveBeenCalled();
  }
});
