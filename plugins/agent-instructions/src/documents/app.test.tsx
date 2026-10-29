import { installDom } from "@bb-plugins/testing";
import { beforeEach, expect, test } from "bun:test";
import { fileSchema } from "./model.ts";
installDom();
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { fireEvent, act } = await import("@testing-library/react");
const { queryClient } = await import("../app/query.ts");
const { resetDocumentDraftsForTest } = await import("./app.tsx");
beforeEach(() => {
  queryClient.clear();
  resetDocumentDraftsForTest();
});
const metadata = {
  globalProjectId: "p",
  projects: [
    {
      id: "p",
      name: "Project",
      sources: [
        {
          id: "a",
          hostId: "host",
          hostName: "Host",
          rootPath: "/a",
          connected: true,
          isDefault: true,
        },
        {
          id: "b",
          hostId: "host",
          hostName: "Host",
          rootPath: "/b",
          connected: true,
          isDefault: false,
        },
      ],
    },
  ],
};
async function page(source: string, rpc = {}) {
  const app = await loadPluginApp(() => import("../app/app.tsx"));
  return renderSlot(
    app.navPanels[0]!,
    { subPath: `projects/p/${source}/AGENTS.md` },
    {
      rpc: {
        documentSources: () => metadata,
        readDocument: (input: unknown) => ({
          content: `Original ${fileSchema.parse(input).rootPath}`,
          sha256: "base",
          readOnly: null,
        }),
        ...rpc,
      },
    },
  );
}
test("drafts stay attached to the selected checkout and survive switching", async () => {
  const first = await page("a");
  const input = await first.findByRole("textbox", { name: "AGENTS.md" });
  fireEvent.change(input, { target: { value: "Draft A" } });
  first.unmount();
  const second = await page("b");
  expect(
    (await second.findByRole("textbox", { name: "AGENTS.md" })).getAttribute("readonly"),
  ).toBeNull();
  expect(second.getByRole("textbox", { name: "AGENTS.md" })).toHaveProperty("value", "Original /b");
  second.unmount();
  const again = await page("a");
  expect(await again.findByRole("textbox", { name: "AGENTS.md" })).toHaveProperty(
    "value",
    "Draft A",
  );
  again.unmount();
});
test("a conflicting save keeps the draft and offers an explicit reload", async () => {
  const slot = await page("a", { saveDocument: () => ({ outcome: "conflict" }) });
  fireEvent.change(await slot.findByRole("textbox", { name: "AGENTS.md" }), {
    target: { value: "My draft" },
  });
  fireEvent.click(slot.getByRole("button", { name: /^Save$/ }));
  await slot.findByText("File changed on disk. Your draft is kept.");
  expect(slot.getByRole("textbox", { name: "AGENTS.md" })).toHaveProperty("value", "My draft");
  slot.unmount();
});
test("late responses from another checkout never replace the selected file", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = await page("a", {
    readDocument: async () => {
      await pending;
      return { content: "Late A", sha256: "a", readOnly: null };
    },
  });
  slow.unmount();
  const current = await page("b");
  await current.findByRole("textbox", { name: "AGENTS.md" });
  await act(async () => release());
  expect(current.getByRole("textbox", { name: "AGENTS.md" })).toHaveProperty(
    "value",
    "Original /b",
  );
  current.unmount();
});
test("new file saves retain create-only CAS even if a refetch finds an external file", async () => {
  let exists = false;
  let saved: unknown;
  const slot = await page("a", {
    readDocument: () => ({
      content: exists ? "Someone else" : "",
      sha256: exists ? "external" : null,
      readOnly: null,
    }),
    saveDocument: (input: unknown) => {
      saved = input;
      return { outcome: "conflict" };
    },
  });
  fireEvent.change(await slot.findByRole("textbox", { name: "AGENTS.md" }), {
    target: { value: "New file" },
  });
  exists = true;
  await act(() => queryClient.invalidateQueries({ queryKey: ["readDocument"] }));
  fireEvent.click(slot.getByRole("button", { name: /^Save$/ }));
  await slot.findByText("File changed on disk. Your draft is kept.");
  expect(saved).toMatchObject({ expectedSha256: null });
  slot.unmount();
});

test("Dotfiles links keep their machine and checkout when opening a source", async () => {
  const app = await loadPluginApp(() => import("../app/app.tsx"));
  const slot = renderSlot(
    app.navPanels[0]!,
    { subPath: "global/at/host/%2Fb/.dotfiles/.agents/instructions/shared.md" },
    {
      rpc: {
        documentSources: () => metadata,
        readDocument: (input: unknown) => ({
          content: fileSchema.parse(input).rootPath,
          sha256: "base",
          readOnly: null,
        }),
      },
    },
  );
  expect(
    await slot.findByRole("textbox", { name: ".dotfiles/.agents/instructions/shared.md" }),
  ).toHaveProperty("value", "/b");
  slot.unmount();
});

test("disconnecting keeps a cached draft visible and disables saving", async () => {
  const slot = await page("a");
  fireEvent.change(await slot.findByRole("textbox", { name: "AGENTS.md" }), {
    target: { value: "Keep me offline" },
  });
  const offline = structuredClone(metadata);
  for (const p of offline.projects) for (const s of p.sources) s.connected = false;
  await act(() => queryClient.setQueryData(queryKeyForSources, offline));
  await slot.findByText(
    "This machine is offline. Cached files remain available; reconnect to save.",
  );
  expect(slot.getByRole("textbox", { name: "AGENTS.md" })).toHaveProperty(
    "value",
    "Keep me offline",
  );
  expect(slot.getByRole("button", { name: /^Save$/ })).toHaveProperty("disabled", true);
  slot.unmount();
});
const queryKeyForSources = ["documentSources"];

async function fileList(online = true, truncated = false) {
  const app = await loadPluginApp(() => import("../app/app.tsx"));
  const registration = app.tabs.find(
    (item): item is Extract<typeof item, { context: { kind: "nav-panel" } }> =>
      item.id === "files" && item.context.kind === "nav-panel",
  );
  if (!registration || registration.availability !== "fixed") throw new Error("Files tab missing");
  const data = structuredClone(metadata);
  for (const p of data.projects) for (const s of p.sources) s.connected = online;
  return renderSlot(
    { component: registration.component },
    { subPath: "projects/p/a" },
    {
      rpc: {
        documentSources: () => data,
        documentFiles: () => ({
          files: ["AGENTS.md", ".agents/skills/sample/references/checklist.md"],
          warnings: [],
          truncated,
        }),
      },
    },
  );
}
test("typing filters a complete cached list without extra host requests", async () => {
  const slot = await fileList();
  await slot.findByRole("button", { name: "AGENTS.md" });
  fireEvent.change(slot.getByRole("textbox", { name: "Find instruction or skill file" }), {
    target: { value: ".agents" },
  });
  await slot.findByRole("button", { name: "references/checklist.md" });
  expect(slot.queryByRole("button", { name: "AGENTS.md" })).toBeNull();
  expect(slot.rpcCalls.filter((c) => c.method === "documentFiles")).toHaveLength(1);
  slot.unmount();
});
test("an offline source without cached files reports that state instead of loading", async () => {
  const slot = await fileList(false);
  await slot.findByText("This machine is offline and no file list is cached.");
  expect(slot.queryByText("Loading files…")).toBeNull();
  slot.unmount();
});
