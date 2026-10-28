import { installDom } from "@bb-plugins/testing";
import { beforeEach, expect, test } from "bun:test";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import { queryClient } from "../src/app/query.ts";
import type { Plugin } from "../src/shared/schema.ts";

installDom();
const { fireEvent, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");

beforeEach(() => queryClient.clear());

const notes: Plugin = {
  id: "notes",
  name: "Notes",
  status: "running",
  readOnly: null,
  tools: [
    {
      name: "notes_find",
      live: "Find a note.",
      file: "instructions/tools/notes_find.md",
      drift: false,
    },
    { name: "notes_code", live: "Defined in code.", file: null, drift: false },
  ],
  files: [
    {
      path: "instructions/tools/notes_find.md",
      kind: "tool-description",
      tool: "notes_find",
      chars: 12,
    },
  ],
};

const rpc = {
  plugins: () => ({ plugins: [notes] }),
  file: () => ({ content: "Find a note.", placeholders: [], maxChars: null }),
};

function loadApp() {
  return loadPluginApp(() => import("../src/app/app.tsx"));
}

async function registration() {
  return (await loadApp()).navPanels[0]!;
}

async function page(subPath: string) {
  return renderSlot(await registration(), { subPath }, { rpc: rpc as never });
}

/** The fixed Plugins tab bb shows beside the page, ready for `renderSlot`. */
async function pluginsTabRegistration() {
  const tab = (await loadApp()).tabs.find(
    (candidate) =>
      candidate.id === "plugins" &&
      candidate.availability === "fixed" &&
      candidate.context.kind === "nav-panel" &&
      candidate.context.panelId === "prompt-editor",
  );
  if (!tab) throw new Error("Prompt Editor declares no Plugins tab");
  return { component: tab.component as ComponentType<PluginNavPanelProps> };
}

async function pluginsTab(subPath: string) {
  return renderSlot(await pluginsTabRegistration(), { subPath }, { rpc: rpc as never });
}

test("the plugin list is the page's Plugins tab, under its saved ids", async () => {
  const app = await loadApp();
  const panel = app.navPanels[0]!;
  expect(panel.path).toBe("prompt-editor");
  expect(panel.fixedTabs).toBeUndefined();
  // Saved panel layouts find the tab by panel id and tab id.
  expect(
    app.tabs.map(({ id, title, context, availability, layout }) => ({
      id,
      title,
      context,
      availability,
      layout,
    })),
  ).toEqual([
    {
      id: "plugins",
      title: "Plugins",
      context: { kind: "nav-panel", panelId: "prompt-editor" },
      availability: "fixed",
      layout: "flush",
    },
  ]);
});

test("with nothing in the URL, the page points to the Plugins tab", async () => {
  const slot = await page("");
  expect(await slot.findByText("Pick a tool, prompt, or skill in the Plugins tab.")).toBeTruthy();
  slot.lifecycle.unmount();
});

test("choosing in the tab puts the choice in the page's URL", async () => {
  const tab = await pluginsTab("");
  fireEvent.click(await tab.findByRole("button", { name: /Notes/ }));
  expect(tab.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "prompt-editor",
      options: { subPath: "notes/file/instructions/tools/notes_find.md" },
    },
  ]);
  tab.lifecycle.unmount();

  const open = await pluginsTab("notes/file/instructions/tools/notes_find.md");
  const code = await open.findByRole("button", { name: /notes_code/ });
  expect(open.getByRole("button", { name: /notes_find/ }).getAttribute("aria-current")).toBe(
    "true",
  );
  fireEvent.click(code);
  expect(open.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "prompt-editor",
      options: { subPath: "notes/tool/notes_code" },
    },
  ]);
  open.lifecycle.unmount();
});

test("names with spaces go to bb raw, which encodes the URL itself", async () => {
  const spaced: Plugin = {
    ...notes,
    tools: [],
    files: [{ path: "instructions/review notes.md", kind: "prompt", tool: null, chars: 12 }],
  };
  const slot = renderSlot(
    await pluginsTabRegistration(),
    { subPath: "" },
    { rpc: { ...rpc, plugins: () => ({ plugins: [spaced] }) } as never },
  );
  fireEvent.click(await slot.findByRole("button", { name: /Notes/ }));
  expect(slot.navigateCalls).toEqual([
    {
      method: "toPluginPanel",
      path: "prompt-editor",
      options: { subPath: "notes/file/instructions/review notes.md" },
    },
  ]);
  slot.lifecycle.unmount();
});

test("the page opens what the URL names", async () => {
  const code = await page("notes/tool/notes_code");
  expect(await code.findByText("Defined in code.")).toBeTruthy();
  code.lifecycle.unmount();

  const file = await page("notes/file/instructions/tools/notes_find.md");
  const editor = await file.findByLabelText("instructions/tools/notes_find.md");
  expect((editor as HTMLTextAreaElement).value).toBe("Find a note.");
  file.lifecycle.unmount();
});

test("an unsaved edit on the page is marked in the tab", async () => {
  const path = "notes/file/instructions/tools/notes_find.md";
  const file = await page(path);
  const tab = await pluginsTab(path);
  const row = await tab.findByRole("button", { name: /notes_find/ });
  expect(within(row).queryByTitle("Unsaved")).toBeNull();

  const editor = await file.findByLabelText("instructions/tools/notes_find.md");
  fireEvent.change(editor, { target: { value: "Find a note by title." } });
  expect(await within(row).findByTitle("Unsaved")).toBeTruthy();

  fireEvent.click(file.getByRole("button", { name: "Revert" }));
  expect(within(row).queryByTitle("Unsaved")).toBeNull();
  tab.lifecycle.unmount();
  file.lifecycle.unmount();
});
