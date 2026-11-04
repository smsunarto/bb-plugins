import { installDom } from "@bb-plugins/testing";
import { beforeEach, expect, test } from "bun:test";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { ComponentType } from "react";
import type { CatalogListing, PublishOutcome } from "../contract.ts";

installDom();
const { fireEvent, waitFor, within } = await import("@testing-library/react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { queryClient } = await import("../../app/query.ts");
const { resetCatalogDraftsForTest } = await import("./state.ts");

beforeEach(() => {
  queryClient.clear();
  resetCatalogDraftsForTest();
});

const sha = (char: string) => char.repeat(64);

const published: PublishOutcome = {
  ok: true,
  at: 1,
  report: {
    linked: [],
    relinked: [],
    unlinked: [],
    unchanged: 2,
    agentsMd: "unchanged",
    conflicts: [],
    failed: [],
    deferred: [],
    removed: 0,
  },
  problems: [],
  warnings: [],
};

function listing(): CatalogListing {
  return {
    revision: 3,
    docs: [
      {
        id: "doc_shared",
        name: "Shared",
        enabled: true,
        origin: { kind: "imported", from: "instructions/shared.md" },
        characters: 13,
        sha256: sha("d"),
      },
    ],
    skills: [
      {
        name: "dev",
        description: "Engineering workflow",
        enabled: true,
        origin: { kind: "authored" },
        treeSha: sha("t"),
        files: [
          { path: "SKILL.md", executable: false, size: 40, text: true },
          { path: "scripts/run.sh", executable: true, size: 20, text: true },
          { path: "logo.png", executable: false, size: 100, text: false },
        ],
      },
      {
        name: "mcp",
        description: "My MCP notes",
        enabled: false,
        origin: { kind: "imported", from: "skills/mcp" },
        treeSha: sha("u"),
        files: [{ path: "SKILL.md", executable: false, size: 30, text: true }],
      },
    ],
    deleted: [{ kind: "skill", key: "old", name: "old", at: 1 }],
    published,
  };
}

type Call = { method: string; input: unknown };

/** A fake catalog server: files by path, and every RPC call in order. */
function server(overrides: Record<string, (input: never) => unknown> = {}) {
  const calls: Call[] = [];
  const files: Record<string, { content: string | null; sha256: string | null }> = {
    "dev/scripts/run.sh": { content: "#!/bin/sh\necho hi\n", sha256: sha("1") },
    "dev/SKILL.md": { content: "---\nname: dev\n---\nBody\n", sha256: sha("2") },
    "dev/logo.png": { content: null, sha256: sha("3") },
    doc_shared: { content: "Shared text.\n", sha256: sha("d") },
  };
  const record = (method: string, handler: (input: never) => unknown) => (input: unknown) => {
    calls.push({ method, input });
    return handler(input as never);
  };
  const rpc = {
    catalog: record("catalog", () => listing()),
    catalogShadows: record("catalogShadows", () => ({
      checked: true,
      shadows: [{ name: "mcp", owner: "plugin bb-guide" }],
    })),
    catalogFile: record("catalogFile", (input: { doc?: string; skill?: string; path?: string }) => {
      const file = files[input.doc ?? `${input.skill}/${input.path}`] ?? {
        content: "",
        sha256: null,
      };
      return { ...file, size: file.content?.length ?? 100, executable: false };
    }),
    changeCatalog: record("changeCatalog", () => ({
      outcome: "saved",
      revision: 4,
      sha256: sha("9"),
      warnings: [],
      published: { ...published, at: 2 },
    })),
    publishCatalog: record("publishCatalog", () => published),
    ...Object.fromEntries(
      Object.entries(overrides).map(([method, handler]) => [method, record(method, handler)]),
    ),
  };
  return { rpc, calls, files };
}

async function panel() {
  const app = await loadPluginApp(() => import("../../app/app.tsx"));
  return app.navPanels[0]!;
}

async function page(subPath: string, fake = server()) {
  return renderSlot(await panel(), { subPath }, { rpc: fake.rpc as never });
}

async function sidebar(subPath: string, fake = server()) {
  const Sidebar = (await panel()).experimental_sidebar as ComponentType<PluginNavPanelProps>;
  return renderSlot({ component: Sidebar }, { subPath }, { rpc: fake.rpc as never });
}

const changes = (calls: Call[]) => calls.filter((c) => c.method === "changeCatalog");

test("the sidebar lists docs and skills with their state, and the filter narrows them", async () => {
  const tab = await sidebar("global/skills/dev/SKILL.md");
  const nav = await tab.findByRole("navigation", { name: "Catalog" });
  expect(within(nav).getByRole("button", { name: /Shared/ })).toBeTruthy();
  const mcp = nav.querySelector('[data-skill="mcp"]')!;
  await waitFor(() => expect(mcp.textContent).toContain("shadows"));
  expect(mcp.textContent).toContain("off");
  expect(within(nav).getByRole("button", { name: "scripts/run.sh" })).toBeTruthy();
  expect(tab.getByText("2 skills · 1 doc")).toBeTruthy();
  expect(tab.getByText("Published")).toBeTruthy();

  fireEvent.change(tab.getByRole("searchbox", { name: "Filter the catalog" }), {
    target: { value: "run.sh" },
  });
  expect(nav.querySelector('[data-skill="mcp"]')).toBeNull();
  expect(nav.querySelector('[data-skill="dev"]')).toBeTruthy();
  expect(within(nav).queryByRole("button", { name: /Shared/ })).toBeNull();
  tab.unmount();
});

test("an encoded doc id from bb's router opens that doc", async () => {
  const slot = await page("global/docs/doc%5Fshared");
  await slot.findByRole("heading", { name: "Shared" });
  slot.unmount();
});

test("an old source-file link under global opens the overview", async () => {
  const slot = await page("global/proj_dotfiles/src_mac/.dotfiles/.agents/instructions/shared.md");
  await slot.findByText("Instructions and skills for every agent");
  slot.unmount();
});

test("a save sends the version it was typed over, then marks the file saved", async () => {
  const fake = server();
  const slot = await page("global/skills/dev/scripts/run.sh", fake);
  const tab = await sidebar("global/skills/dev/scripts/run.sh", fake);
  const editor = await slot.findByRole("textbox", { name: "scripts/run.sh" });
  fireEvent.change(editor, { target: { value: "#!/bin/sh\necho bye\n" } });
  await waitFor(() => expect(tab.container.querySelector(".pe-dot")).toBeTruthy());

  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await slot.findByText("Saved. Agents get it in their next session.");
  expect(changes(fake.calls).at(-1)?.input).toEqual({
    op: "saveFile",
    skill: "dev",
    path: "scripts/run.sh",
    content: "#!/bin/sh\necho bye\n",
    expectedSha256: sha("1"),
  });
  await waitFor(() => expect(tab.container.querySelector(".pe-dot")).toBeNull());
  slot.unmount();
  tab.unmount();
});

test("a file changed elsewhere keeps the draft and asks before overwriting", async () => {
  const fake = server({ changeCatalog: () => ({ outcome: "conflict", message: "Changed" }) });
  const slot = await page("global/skills/dev/scripts/run.sh", fake);
  fireEvent.change(await slot.findByRole("textbox", { name: "scripts/run.sh" }), {
    target: { value: "mine\n" },
  });
  fake.files["dev/scripts/run.sh"] = { content: "theirs\n", sha256: sha("5") };
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await slot.findByText("This file changed in bb after you started editing.");
  expect(slot.getByRole("textbox", { name: "scripts/run.sh" })).toHaveProperty("value", "mine\n");
  expect(slot.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);

  fireEvent.click(slot.getByRole("button", { name: "Overwrite with mine" }));
  await waitFor(() =>
    expect(changes(fake.calls).at(-1)?.input).toMatchObject({
      content: "mine\n",
      expectedSha256: sha("5"),
    }),
  );
  slot.unmount();
});

test("a failed publish after a save says so and can be retried", async () => {
  const fake = server({
    changeCatalog: () => ({
      outcome: "saved",
      revision: 4,
      sha256: sha("9"),
      warnings: [],
      published: { ok: false, at: 2, error: "disk full" },
    }),
  });
  const slot = await page("global/docs/doc_shared", fake);
  await slot.findByRole("heading", { name: "Shared" });
  fireEvent.click(slot.getByRole("switch", { name: "Shared on" }));
  await slot.findByText(/Turned off, but publishing did not finish: disk full/);
  fireEvent.click(slot.getByRole("button", { name: "Retry publish" }));
  await slot.findByText("Turned off. Agents get it in their next session.");
  expect(fake.calls.some((c) => c.method === "publishCatalog")).toBe(true);
  slot.unmount();
});

test("binary files are shown read-only", async () => {
  const slot = await page("global/skills/dev/logo.png");
  await slot.findByText(/not editable text \(100 bytes\)/);
  expect(slot.queryByRole("textbox")).toBeNull();
  expect(slot.getByRole("button", { name: "Delete file" })).toBeTruthy();
  slot.unmount();
});

test("deleting a skill asks first, then returns to the overview with a restore hint", async () => {
  const fake = server();
  const slot = await page("global/skills/dev/SKILL.md", fake);
  fireEvent.click(await slot.findByRole("button", { name: "Delete skill" }));
  expect(changes(fake.calls)).toHaveLength(0);
  fireEvent.click(slot.getByRole("button", { name: "Delete dev" }));
  await waitFor(() => expect(slot.navigateCalls.at(-1)?.method).toBe("toPluginPanel"));
  expect(changes(fake.calls).at(-1)?.input).toEqual({
    op: "deleteSkill",
    name: "dev",
    expectedTreeSha: sha("t"),
  });
  expect(slot.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel",
    path: "instructions",
    options: { subPath: "global" },
  });
  slot.unmount();
  const overview = await page("global", fake);
  await overview.findByText("Deleted dev. Restore it from Recently deleted.");
  overview.unmount();
});

test("a new skill opens its SKILL.md, and a refused name shows why", async () => {
  let refuse = true;
  const fake = server({
    changeCatalog: () =>
      refuse
        ? { outcome: "invalid", errors: ["mcp would hide the mcp skill from bb-guide"] }
        : { outcome: "saved", revision: 5, warnings: [], published },
  });
  const tab = await sidebar("global", fake);
  fireEvent.click(await tab.findByRole("button", { name: "+ New skill" }));
  fireEvent.change(tab.getByRole("textbox", { name: "Skill name" }), {
    target: { value: "mcp" },
  });
  fireEvent.change(tab.getByRole("textbox", { name: "Skill description" }), {
    target: { value: "Mine" },
  });
  fireEvent.click(tab.getByRole("button", { name: "Create" }));
  await tab.findByText("mcp would hide the mcp skill from bb-guide");

  refuse = false;
  fireEvent.change(tab.getByRole("textbox", { name: "Skill name" }), {
    target: { value: "notes" },
  });
  fireEvent.click(tab.getByRole("button", { name: "Create" }));
  await waitFor(() =>
    expect(tab.navigateCalls.at(-1)).toEqual({
      method: "toPluginPanel",
      path: "instructions",
      options: { subPath: "global/skills/notes/SKILL.md" },
    }),
  );
  expect(changes(fake.calls).at(-1)?.input).toEqual({
    op: "createSkill",
    name: "notes",
    description: "Mine",
  });
  tab.unmount();
});

test("a deleted skill can be restored from the sidebar", async () => {
  const fake = server();
  const tab = await sidebar("global", fake);
  const deleted = await tab.findByRole("region", { name: "Recently deleted" });
  fireEvent.click(within(deleted).getByRole("button", { name: "Restore" }));
  await waitFor(() =>
    expect(changes(fake.calls).at(-1)?.input).toEqual({ op: "restore", kind: "skill", key: "old" }),
  );
  tab.unmount();
});

test("typing back to the old text while a save runs keeps that text as unsaved", async () => {
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const fake = server({
    changeCatalog: async () => {
      await gate;
      return { outcome: "saved", revision: 4, sha256: sha("9"), warnings: [], published };
    },
  });
  const slot = await page("global/skills/dev/scripts/run.sh", fake);
  const editor = await slot.findByRole("textbox", { name: "scripts/run.sh" });
  const original = "#!/bin/sh\necho hi\n";
  fireEvent.change(editor, { target: { value: "B\n" } });
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(changes(fake.calls)).toHaveLength(1));
  fireEvent.change(editor, { target: { value: original } });
  fake.files["dev/scripts/run.sh"] = { content: "B\n", sha256: sha("9") };
  release();
  await waitFor(() =>
    expect(slot.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false),
  );
  expect(slot.getByRole("textbox", { name: "scripts/run.sh" })).toHaveProperty("value", original);
  slot.unmount();
});
