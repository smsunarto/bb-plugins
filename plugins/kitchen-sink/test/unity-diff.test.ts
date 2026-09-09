import { expect, test } from "bun:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { buildUnityDiff, parseUnityObjects } from "../src/server/lib/unity-diff.ts";
import { applyUnityPatch } from "../src/server/lib/unity-patch.ts";
import plugin from "../src/server/server.ts";

const before = `%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!1 &9007199254740993
GameObject:
  m_Name: Player
  m_IsActive: 1
--- !u!4 &9007199254740994
Transform:
  m_GameObject: {fileID: 9007199254740993}
  m_LocalPosition: {x: 0, y: 1, z: 0}
  m_Father: {fileID: 0}
--- !u!114 &3
MonoBehaviour:
  m_GameObject: {fileID: 9007199254740993}
  m_EditorClassIdentifier: Assembly-CSharp::PlayerMovement
  speed: 5
  target: {fileID: 9007199254740994}
  items:
  - name: rifle
    count: 1
`;
const after = before
  .replace("{x: 0, y: 1, z: 0}", "{x: 0, y: 2, z: 0}")
  .replace("speed: 5", "speed: 8");
const patch = `diff --git a/Player.prefab b/Player.prefab
--- a/Player.prefab
+++ b/Player.prefab
@@ -9,3 +9,3 @@
   m_GameObject: {fileID: 9007199254740993}
-  m_LocalPosition: {x: 0, y: 1, z: 0}
+  m_LocalPosition: {x: 0, y: 2, z: 0}
   m_Father: {fileID: 0}
@@ -15,3 +15,3 @@
   m_EditorClassIdentifier: Assembly-CSharp::PlayerMovement
-  speed: 5
+  speed: 8
   target: {fileID: 9007199254740994}
`;

test("matches 64-bit Unity IDs and groups component properties under their named GameObject", () => {
  expect(applyUnityPatch(before, patch)).toBe(after);
  const result = buildUnityDiff(before, after, patch);
  expect(result.groups).toHaveLength(1);
  expect(result.groups[0]).toMatchObject({
    id: "9007199254740993",
    name: "Player",
    status: "modified",
  });
  expect(result.groups[0]!.components.map((item) => item.type)).toEqual([
    "Transform",
    "PlayerMovement",
  ]);
  expect(result.propertyCount).toBe(2);
  expect(result.groups[0]!.components[0]!.properties).toEqual([
    { path: "m_LocalPosition", before: "{x: 0, y: 1, z: 0}", after: "{x: 0, y: 2, z: 0}" },
  ]);
});

test("selected hunks exclude changes elsewhere in the asset", () => {
  const result = buildUnityDiff(before, after, patch.slice(0, patch.indexOf("@@ -15")));
  expect(result.propertyCount).toBe(1);
  expect(result.groups[0]!.components.map((item) => item.type)).toEqual(["Transform"]);
});

test("references resolve names without rounding IDs or confusing external assets with local IDs", () => {
  const modified = before.replace(
    "target: {fileID: 9007199254740994}",
    "target: {fileID: 9007199254740994, guid: abcdef}",
  );
  const result = buildUnityDiff(before, modified, "@@ -17 +17 @@\n-old\n+new\n");
  expect(result.groups[0]!.components[0]!.properties[0]).toEqual({
    path: "target",
    before: "Player · Transform (#9007199254740994)",
    after: '{fileID: 9007199254740994, guid: "abcdef"}',
  });
});

test("added and removed objects retain their names and full property inventory", () => {
  const added = buildUnityDiff(
    "",
    before,
    `@@ -0,0 +1,20 @@\n${before
      .trimEnd()
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n")}`,
  );
  expect(added.groups[0]).toMatchObject({ name: "Player", status: "added" });
  expect(added.groups[0]!.components.every((item) => item.status === "added")).toBe(true);
  const removed = buildUnityDiff(
    before,
    "",
    `@@ -1,20 +0,0 @@\n${before
      .trimEnd()
      .split("\n")
      .map((line) => `-${line}`)
      .join("\n")}`,
  );
  expect(removed.groups[0]).toMatchObject({ name: "Player", status: "removed" });
  expect(removed.groups[0]!.components[0]!.properties.every((item) => item.after === null)).toBe(
    true,
  );
});

test("nested prefab overrides, stripped objects, arrays and multiline properties survive parsing", () => {
  const source = `--- !u!1001 &45
PrefabInstance:
  m_Modification:
    m_Modifications:
    - target: {fileID: 123, guid: deadbeef, type: 3}
      propertyPath: m_Name
      value: Child
      objectReference: {fileID: 0}
--- !u!4 &46 stripped
Transform:
  m_CorrespondingSourceObject: {fileID: 123, guid: deadbeef, type: 3}
  m_PrefabInstance: {fileID: 45}
--- !u!114 &47
MonoBehaviour:
  description: |-
    first
    second
`;
  const objects = parseUnityObjects(source);
  expect(
    [...objects.get("45")!.fields.values()].find((field) => field.label === "m_Name")!.value,
  ).toBe("Child");
  expect(objects.get("47")!.fields.get("description")).toMatchObject({
    value: "first\nsecond",
    first: 15,
    last: 17,
  });
  expect(objects.get("46")!.type).toBe("Transform");
});

test("rejects malformed YAML, duplicate file IDs, aliases and non-Unity documents", () => {
  for (const source of [
    "hello",
    before + before,
    "--- !u!1 &1\nGameObject: [broken",
    "--- !u!1 &1\nGameObject:\n  a: &a [1]\n  b: *a\n",
  ]) {
    expect(() => parseUnityObjects(source)).toThrow();
  }
});

test("exact patch application handles new/deleted files, insertion, deletion and absent final newline", () => {
  expect(applyUnityPatch("", "@@ -0,0 +1,2 @@\n+a\n+b\n")).toBe("a\nb\n");
  expect(applyUnityPatch("a\nb\n", "@@ -1,2 +0,0 @@\n-a\n-b\n")).toBe("");
  expect(applyUnityPatch("a\nb\n", "@@ -1,0 +2 @@\n+c\n")).toBe("a\nc\nb\n");
  expect(applyUnityPatch("a\nb\n", "@@ -1 +0,0 @@\n-a\n")).toBe("b\n");
  expect(
    applyUnityPatch(
      "a",
      "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n",
    ),
  ).toBe("b");
  expect(() => applyUnityPatch("changed\n", "@@ -1 +1 @@\n-a\n+b\n")).toThrow("Patch base changed");
  expect(() => applyUnityPatch("a\n", "@@ -1,2 +1,2 @@\n-a\n+b\n")).toThrow();
});

test("Unity snapshots retain the semantic view after workspace changes and plugin reload", async () => {
  const host = createFakePluginHost({ pluginId: "kitchen-sink" });
  host.harness.sdk.stub("threads.get", () => makeThreadResponse({ environmentId: "env-1" }));
  host.harness.sdk.stub("environments.get", () => ({ id: "env-1", mergeBaseBranch: "main" }));
  host.harness.sdk.stub("environments.diffPatch", () => ({
    outcome: "available",
    patches: [{ path: "Player.prefab", patch, truncated: false }],
  }));
  host.harness.sdk.stub("environments.diffFiles", () => ({
    outcome: "available",
    mergeBaseRef: "aabbccdd",
    files: [{ path: "Player.prefab", previousPath: null, binary: false }],
  }));
  host.harness.sdk.stub("environments.diffFile", () => ({
    content: before,
    contentEncoding: "utf8",
    sizeBytes: before.length,
  }));
  await plugin(host.bb);
  const request = {
    kind: "diff",
    threadId: "thread-1",
    messageId: "message-unity",
    path: "Player.prefab",
  };
  const result = await host.harness.callRpc("renderEmbed", request);
  expect(result).toMatchObject({ status: "ready", unity: { propertyCount: 2 } });
  expect(host.harness.sdk.callsTo("environments.diffFile")[0]![0]).toMatchObject({
    mergeBaseRef: "aabbccdd",
    side: "old",
  });
  const reloaded = await host.harness.lifecycle.reload(plugin);
  expect(await reloaded.harness.callRpc("renderEmbed", request)).toEqual(result);
  expect(reloaded.harness.sdk.callsTo("environments.diffFile")).toHaveLength(0);
  await reloaded.harness.lifecycle.dispose();
});

test("missing or truncated Unity sources preserve the raw diff", async () => {
  const host = createFakePluginHost({ pluginId: "kitchen-sink" });
  host.harness.sdk.stub("threads.get", () => makeThreadResponse({ environmentId: "env-1" }));
  host.harness.sdk.stub("environments.get", () => ({ id: "env-1", mergeBaseBranch: "main" }));
  host.harness.sdk.stub("environments.diffPatch", () => ({
    outcome: "available",
    patches: [{ path: "Player.unity", patch, truncated: true }],
  }));
  await plugin(host.bb);
  const result = await host.harness.callRpc("renderEmbed", {
    kind: "diff",
    threadId: "thread-1",
    path: "Player.unity",
  });
  expect(result).toMatchObject({
    status: "ready",
    patch,
    unityNotice: expect.stringContaining("Showing YAML"),
  });
  expect(result).not.toHaveProperty("unity");
  expect(host.harness.sdk.callsTo("environments.diffFile")).toHaveLength(0);
  await host.harness.lifecycle.dispose();
});

test("prefab overrides match by target and property rather than array position", () => {
  const header = "--- !u!1001 &1\nPrefabInstance:\n  m_Modification:\n    m_Modifications:\n";
  const item = (property: string, value: string) =>
    `    - target: {fileID: 123, guid: abcd, type: 3}\n      propertyPath: ${property}\n      value: ${value}\n      objectReference: {fileID: 0}\n`;
  const old = header + item("m_Name", "Cameras") + item("orthographic size", "9");
  const next = header + item("orthographic size", "7") + item("m_Name", "Cameras");
  const all = `@@ -1,12 +1,12 @@\n${old
    .trimEnd()
    .split("\n")
    .map((line) => `-${line}`)
    .join("\n")}\n${next
    .trimEnd()
    .split("\n")
    .map((line) => `+${line}`)
    .join("\n")}\n`;
  const result = buildUnityDiff(old, next, all);
  expect(result.groups[0]).toMatchObject({ name: "Cameras" });
  expect(result.groups[0]!.components[0]).toMatchObject({ type: "Prefab overrides" });
  expect(result.groups[0]!.components[0]!.properties).toHaveLength(1);
  expect(result.groups[0]!.components[0]!.properties[0]).toMatchObject({
    label: "orthographic size",
    target: "123",
    before: "9",
    after: "7",
  });
});

test("array insertions include shifted indices even when their YAML lines are context", () => {
  const old = "--- !u!114 &1\nMonoBehaviour:\n  items:\n  - a\n  - b\n";
  const next = old.replace("  - a", "  - c\n  - a");
  const patch = "@@ -3,1 +3,2 @@\n   items:\n+  - c\n";
  const result = buildUnityDiff(old, next, patch);
  expect(result.groups[0]!.components[0]!.properties).toEqual([
    { path: "items[0]", before: '"a"', after: '"c"' },
    { path: "items[1]", before: '"b"', after: '"a"' },
    { path: "items[2]", before: null, after: '"b"' },
  ]);
});

test("a renamed Unity asset reads its prior path with the resolved merge-base SHA", async () => {
  const host = createFakePluginHost({ pluginId: "kitchen-sink" });
  host.harness.sdk.stub("threads.get", () => makeThreadResponse({ environmentId: "env-1" }));
  host.harness.sdk.stub("environments.get", () => ({ id: "env-1", mergeBaseBranch: "main" }));
  host.harness.sdk.stub("environments.diffPatch", () => ({
    outcome: "available",
    patches: [{ path: "Hero.prefab", patch, truncated: false }],
  }));
  host.harness.sdk.stub("environments.diffFiles", () => ({
    outcome: "available",
    mergeBaseRef: "aabbccdd",
    files: [{ path: "Hero.prefab", previousPath: "Player.prefab", binary: false }],
  }));
  host.harness.sdk.stub("environments.diffFile", () => ({
    content: before,
    contentEncoding: "utf8",
    sizeBytes: before.length,
  }));
  await plugin(host.bb);
  expect(
    await host.harness.callRpc("renderEmbed", {
      kind: "diff",
      threadId: "thread-rename",
      path: "Hero.prefab",
    }),
  ).toMatchObject({ unity: { propertyCount: 2 } });
  expect(host.harness.sdk.callsTo("environments.diffFile")[0]![0]).toMatchObject({
    path: "Player.prefab",
    mergeBaseRef: "aabbccdd",
    target: "all",
  });
  await host.harness.lifecycle.dispose();
});

test("deleting an unterminated last line preserves the previous line terminator", () => {
  expect(applyUnityPatch("a\nb", "@@ -2 +1,0 @@\n-b\n\\ No newline at end of file\n")).toBe("a\n");
});
