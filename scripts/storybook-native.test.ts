import { expect, test } from "bun:test";
import { previewURL } from "../.storybook/editor-frame";

test("isolated transition preserves Controls args and every global", () => {
  const location = {
    storyId: "screens-tasks-views--list",
    viewMode: "story",
    globals: { context: "editor", width: "narrow", locale: "en-US", flags: { compact: true } },
    initialArgs: { view: "list", enabled: false },
    args: { view: "board", enabled: true },
  };
  const url = new URL(previewURL(location, true, "http://localhost:6010/iframe.html?foo=bar"));
  expect(url.searchParams.get("id")).toBe(location.storyId);
  expect(url.searchParams.get("foo")).toBe("bar");
  expect(url.searchParams.get("args")).toContain("view:board");
  expect(url.searchParams.get("args")).toContain("enabled:!true");
  expect(url.searchParams.get("globals")).toContain("context:isolated");
  expect(url.searchParams.get("globals")).toContain("locale:en-US");
  expect(url.searchParams.get("globals")).toContain("flags.compact:!true");
});

test("Docs isolation reload retains the document route", () => {
  const url = new URL(
    previewURL(
      {
        storyId: "components-docs-document-card--html-card",
        viewMode: "docs",
        globals: { context: "isolated" },
        initialArgs: {},
        args: {},
      },
      false,
      "http://localhost:6010/iframe.html?id=components-docs-document-card--docs&args=label:custom",
    ),
  );
  expect(url.searchParams.get("id")).toBe("components-docs-document-card--docs");
  expect(url.searchParams.get("args")).toBe("label:custom");
});
