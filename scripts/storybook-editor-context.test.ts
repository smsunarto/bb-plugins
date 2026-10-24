import { expect, test } from "bun:test";
import { editorContextFor, showsEditor } from "../.storybook/editor-context";

test("editor previews follow plugin placements", () => {
  expect(editorContextFor("Screens/GitHub Stack/Stack panel")?.placement).toBe("thread-panel");
  expect(editorContextFor("Screens/Docs/Document browser")?.placement).toBe("page");
  expect(editorContextFor("Components/Docs/Document card")?.placement).toBe("message");
  expect(editorContextFor("Components/Devin/Cloud session")?.placement).toBe("composer");
  expect(editorContextFor("Components/Inline Visualizations/Tweak panel")?.placement).toBe(
    "dialog",
  );
  expect(editorContextFor("Components/Agent Instructions/Rule card")?.placement).toBe("settings");
  expect(editorContextFor("Components/GTD Sidebar/Thread cards")?.placement).toBe("sidebar");
});

test("Docs stay compact by default and editor mode is explicit", () => {
  expect(showsEditor("auto", "story")).toBe(true);
  expect(showsEditor("auto", "docs")).toBe(false);
  expect(showsEditor("auto", "story", true)).toBe(false);
  expect(showsEditor("editor", "story", true)).toBe(true);
  expect(showsEditor("editor", "docs")).toBe(true);
  expect(showsEditor("isolated", "story")).toBe(false);
  expect(editorContextFor("Components/Shared/Button")).toBeUndefined();
  expect(editorContextFor("Components/Theme/bb Monokai")).toBeUndefined();
  expect(editorContextFor("Components/Unregistered/Widget")).toBeUndefined();
});
