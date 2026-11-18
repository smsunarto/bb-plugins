import { expect, test } from "bun:test";
import { affected, pushedFiles, readWorkspaces, type Workspace } from "./pre-push";

const workspace = (name: string, dir: string, deps: string[] = []): Workspace => ({
  name,
  dir,
  deps,
  scripts: { test: "bun test", typecheck: "tsc --noEmit" },
});

const ui = workspace("@bb-plugins/ui", "packages/ui");
const editor = workspace("@bb-plugins/markdown-editor", "packages/markdown-editor", [ui.name]);
const genui = workspace("@smsunarto/bb-plugin-genui", "plugins/genui", [ui.name]);
const tasks = workspace("@smsunarto/bb-plugin-scott-tasks", "plugins/scott-tasks", [editor.name]);
const all = [ui, editor, genui, tasks];

test("a plugin change checks that plugin alone", () => {
  expect(affected(["plugins/genui/core/streaming.ts"], all)).toEqual(new Set([genui.name]));
});

test("a shared package change checks every package that depends on it, transitively", () => {
  expect(affected(["packages/ui/src/button.tsx"], all)).toEqual(
    new Set([ui.name, editor.name, genui.name, tasks.name]),
  );
  expect(affected(["packages/markdown-editor/src/index.ts"], all)).toEqual(
    new Set([editor.name, tasks.name]),
  );
});

test("a change outside any package checks everything", () => {
  for (const file of [
    "bun.lock",
    "package.json",
    "scripts/lint.ts",
    "tsconfig.base.json",
    "plugins/README.md",
  ]) {
    expect(affected(["plugins/genui/core/streaming.ts", file], all)).toBe("all");
  }
});

test("the real workspace graph links plugins to the shared packages they import", () => {
  const real = readWorkspaces(process.cwd());
  const scope = affected(["packages/ui/package.json"], real);
  expect(scope).not.toBe("all");
  expect(scope).toContain("@smsunarto/bb-plugin-genui");
  expect(scope).not.toContain("@bb-plugins/instructions");
});

test("a hook run without git's ref lines checks everything", () => {
  expect(pushedFiles("")).toBe("all");
  expect(pushedFiles("\n")).toBe("all");
});
