import { expect, test } from "bun:test";
import { checkoutSlots } from "./checkout-slots.ts";
import type { EditorInstance } from "../../shared/unity-editor-contract.ts";

const main: EditorInstance = {
  id: "main",
  projectPath: "/game",
  workspacePath: "/game",
  pid: 101,
  port: 7800,
  version: "6000.3.10f1",
  startedAt: "birth",
  clone: false,
};

test("slot identity survives Editor restarts and is scoped to the host and physical checkout", () => {
  const original = checkoutSlots("host-a", [main], [])[0]!;
  const restarted = checkoutSlots("host-a", [{ ...main, id: "new-process", pid: 202 }], [])[0]!;
  const otherHost = checkoutSlots("host-b", [main], [])[0]!;
  const otherCheckout = checkoutSlots("host-a", [{ ...main, workspacePath: "/worktree" }], [])[0]!;
  expect(original.id).toMatch(/^slot-[a-f0-9]{24}$/);
  expect(restarted.id).toBe(original.id);
  expect(new Set([original.id, otherHost.id, otherCheckout.id]).size).toBe(3);
  expect(restarted.mainEditors.map((editor) => editor.id)).toEqual(["new-process"]);
});
