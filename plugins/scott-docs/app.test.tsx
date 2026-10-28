// @vitest-environment jsdom
import type { ExperimentalTabRegistration } from "@get-bb/plugin-sdk";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { loadPluginApp, renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
const { clearNotebookStores } = await import("./app");
const docsRegistration = app.navPanels[0];
if (!docsRegistration) throw new Error("Docs navigation panel was not registered");
const navigationView = app.tabs.find(
  (
    tab,
  ): tab is Extract<
    ExperimentalTabRegistration,
    { context: { kind: "nav-panel" }; availability: "fixed" }
  > => tab.context.kind === "nav-panel" && tab.availability === "fixed" && tab.id === "navigation",
);
if (!navigationView) throw new Error("Docs navigation tab was not registered");
const navigationRegistration = {
  ...docsRegistration,
  component: navigationView.component,
};
const rangeGetBoundingClientRectDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getBoundingClientRect",
);
const rangeGetClientRectsDescriptor = Object.getOwnPropertyDescriptor(
  Range.prototype,
  "getClientRects",
);

beforeEach(() => {
  localStorage.clear();
  clearNotebookStores();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: {
      configurable: true,
      value: () => new DOMRect(),
    },
    getClientRects: {
      configurable: true,
      value: () => ({ length: 0, item: () => null }),
    },
  });
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (rangeGetBoundingClientRectDescriptor) {
    Object.defineProperty(
      Range.prototype,
      "getBoundingClientRect",
      rangeGetBoundingClientRectDescriptor,
    );
  } else {
    Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  }
  if (rangeGetClientRectsDescriptor) {
    Object.defineProperty(Range.prototype, "getClientRects", rangeGetClientRectsDescriptor);
  } else {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  }
});

interface NoteSummary {
  path: string;
  title: string;
  preview: string;
  modifiedAtMs: number;
}

function listNotesResult(
  notes: NoteSummary[],
  entries: Array<{ kind: "file" | "directory"; path: string }> = notes.map((note) => ({
    kind: "file",
    path: note.path,
  })),
  entryOrder: string[] = [],
) {
  return {
    vaults: [
      {
        id: "personal",
        name: "Personal",
        hostId: "host_local",
        rootPath: "/Users/me/Notes",
      },
    ],
    vault: {
      id: "personal",
      name: "Personal",
      hostId: "host_local",
      rootPath: "/Users/me/Notes",
    },
    hosts: [{ id: "host_local", name: "My Mac", status: "connected" }],
    entries,
    entryOrder,
    notes,
    truncated: false,
    error: null,
  };
}

function listNotesResultForVault(vaultId: "personal" | "work", path: string, title: string) {
  return {
    ...listNotesResult([{ path, title, preview: "", modifiedAtMs: 1 }]),
    vaults: [
      {
        id: "personal",
        name: "Personal",
        hostId: "host_local",
        rootPath: "/vaults/personal",
      },
      {
        id: "work",
        name: "Work",
        hostId: "host_local",
        rootPath: "/vaults/work",
      },
    ],
    vault: {
      id: vaultId,
      name: vaultId === "work" ? "Work" : "Personal",
      hostId: "host_local",
      rootPath: `/vaults/${vaultId}`,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const preview = {
  baseUrl: "/api/v1/file-previews/lease",
  expiresAtMs: Date.now() + 60_000,
};

function renderDocument(path: string, title: string, options: RenderSlotOptions) {
  return renderSlot(
    app.messageDirectives[0]!,
    {
      attributes: { vault: "personal", path, title },
      source: `::docs{vault="personal" path="${path}" title="${title}"}`,
      message: {
        id: `msg_${path}`,
        threadId: "thr_1",
        turnId: "turn_1",
        projectId: null,
      },
      openWorkspaceFile: null,
    },
    {
      ...options,
      rpc: {
        readNote: () => ({
          content: "Original paragraph.",
          sha256: "original-sha",
        }),
        readProposal: () => null,
        preparePreview: () => preview,
        ...options.rpc,
      },
    },
  );
}

function makeDataTransfer(path = "") {
  let storedPath = path;
  return {
    effectAllowed: "none",
    dropEffect: "none",
    types: ["text/plain"],
    setData: vi.fn((_type: string, value: string) => {
      storedPath = value;
    }),
    getData: vi.fn(() => storedPath),
  };
}

function queryTreeItem(container: HTMLElement, name: string) {
  const tree = container.querySelector<HTMLElement>("[data-docs-tree]");
  return (
    [...(tree?.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? [])].find(
      (item) => item.getAttribute("aria-label") === name,
    ) ?? null
  );
}

async function findTreeItem(container: HTMLElement, name: string) {
  let item: HTMLButtonElement | null = null;
  await waitFor(() => {
    item = queryTreeItem(container, name);
    expect(item).toBeTruthy();
  });
  return item!;
}

function treeItemLabels(container: HTMLElement) {
  const tree = container.querySelector<HTMLElement>("[data-docs-tree]");
  return [
    ...(tree?.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []),
  ].map((item) => item.getAttribute("aria-label"));
}

describe("Docs nav panel", () => {
  it("remembers the document and restores it when the panel reopens", async () => {
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/plans/My report.html" },
      { rpc: { listNotes: () => listNotesResult([]), preparePreview: () => preview } },
    );
    await slot.findByTitle("plans/My report.html");
    expect(localStorage.getItem("bb-plugin-scott-docs:last-document")).toBe(
      "personal/plans/My report.html",
    );
    cleanup();
    const reopened = renderSlot(
      docsRegistration,
      { subPath: "" },
      { rpc: { listNotes: () => listNotesResult([]) } },
    );
    await waitFor(() =>
      expect(reopened.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "docs",
        options: { subPath: "personal/plans/My report.html", replace: true },
      }),
    );
  });

  it("honors explicit vault navigation instead of restoring an old document", async () => {
    localStorage.setItem("bb-plugin-scott-docs:last-document", "personal/old.md");
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal" },
      { rpc: { listNotes: () => listNotesResult([]) } },
    );
    await slot.findByText("Select a note or HTML page.");
    expect(slot.navigateCalls).toEqual([]);
    expect(localStorage.getItem("bb-plugin-scott-docs:last-document")).toBe("personal");
  });

  it("remembers the last vault and restores it after a cold reopen", async () => {
    const slot = renderSlot(
      docsRegistration,
      { subPath: "work" },
      { rpc: { listNotes: () => listNotesResultForVault("work", "plan.md", "Plan") } },
    );
    await slot.findByText("Select a note or HTML page.");
    expect(localStorage.getItem("bb-plugin-scott-docs:last-document")).toBe("work");
    cleanup();
    clearNotebookStores();

    const reopened = renderSlot(
      docsRegistration,
      { subPath: "" },
      { rpc: { listNotes: () => listNotesResult([]) } },
    );
    await waitFor(() =>
      expect(reopened.navigateCalls).toContainEqual({
        method: "toPluginPanel",
        path: "docs",
        options: { subPath: "work", replace: true },
      }),
    );
  });

  it("ignores malformed saved locations", async () => {
    localStorage.setItem("bb-plugin-scott-docs:last-document", "%invalid");
    const slot = renderSlot(
      docsRegistration,
      { subPath: "" },
      { rpc: { listNotes: () => listNotesResult([]) } },
    );
    await slot.findByText("Select a note or HTML page.");
    expect(slot.navigateCalls).toEqual([]);
  });

  it("lets readers recover when the remembered vault was removed", async () => {
    const slot = renderSlot(
      docsRegistration,
      { subPath: "gone" },
      {
        rpc: {
          listNotes: () => {
            throw new Error("Unknown vault: gone");
          },
        },
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Browse default vault" }));
    expect(localStorage.getItem("bb-plugin-scott-docs:last-document")).toBeNull();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "", replace: true },
    });
    cleanup();
    const reopened = renderSlot(
      docsRegistration,
      { subPath: "" },
      { rpc: { listNotes: () => listNotesResult([]) } },
    );
    await reopened.findByText("Select a note or HTML page.");
    expect(reopened.navigateCalls).toEqual([]);
  });

  it("keeps the sidebar from moving the reader to the saved document", async () => {
    localStorage.setItem("bb-plugin-scott-docs:last-document", "personal/old.md");
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "" },
      { rpc: { listNotes: () => listNotesResult([]) } },
    );
    await slot.findByRole("navigation", { name: "Notes" });
    expect(slot.navigateCalls).toEqual([]);
    expect(localStorage.getItem("bb-plugin-scott-docs:last-document")).toBe("personal/old.md");
  });

  it("registers the Docs surfaces", () => {
    expect(app.navPanels[0]).toMatchObject({
      id: "docs",
      title: "Docs",
      path: "docs",
    });
    expect(app.navPanels[0]).not.toHaveProperty("fixedTabs");
    expect(app.navPanels[0]?.headerContent).toBeUndefined();
    expect(app.messageDirectives).toHaveLength(1);
    expect(app.messageDirectives[0]?.id).toBe("docs");
    expect(app.tabs).toEqual([
      expect.objectContaining({
        context: { kind: "nav-panel", panelId: "docs" },
        availability: "fixed",
        id: "navigation",
        title: "Navigation",
        icon: "ListView",
        layout: "flush",
      }),
      expect.objectContaining({
        context: { kind: "thread" },
        availability: "action",
        id: "document",
        title: "Document",
        icon: "FileText",
      }),
    ]);
    expect(app.fileOpeners[0]).toMatchObject({
      id: "docs",
      title: "Docs",
      extensions: ["md", "markdown"],
    });
  });

  it("renders the vault with Pierre Trees and bb theme tokens", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal/projects/roadmap.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [
                {
                  path: "projects/roadmap.md",
                  title: "Roadmap",
                  preview: "Quarterly priorities",
                  modifiedAtMs: 1,
                },
                {
                  path: "projects/notes.md",
                  title: "Notes",
                  preview: "Working notes",
                  modifiedAtMs: 2,
                },
              ],
              [
                { kind: "directory", path: "projects" },
                { kind: "file", path: "projects/roadmap.md" },
                { kind: "file", path: "projects/notes.md" },
              ],
            ),
        },
      },
    );

    const folder = await findTreeItem(slot.container, "projects");
    const file = await findTreeItem(slot.container, "roadmap.md");
    const sibling = await findTreeItem(slot.container, "notes.md");
    const tree = slot.container.querySelector<HTMLElement>("[data-docs-tree]");
    expect(tree?.tagName.toLowerCase()).toBe("file-tree-container");
    expect(tree?.style.getPropertyValue("--trees-bg-override")).toBe("var(--sidebar)");
    expect(tree?.style.getPropertyValue("--trees-selected-bg-override")).toBe(
      "var(--sidebar-accent)",
    );
    expect(folder.getAttribute("data-item-type")).toBe("folder");
    expect(folder.getAttribute("aria-expanded")).toBe("true");
    expect(file.getAttribute("aria-level")).toBe("2");
    expect(file.getAttribute("aria-selected")).toBe("true");
    expect(sibling.getAttribute("aria-selected")).toBe("false");
  });

  it("renders navigation in the BB-owned right-panel view without custom chrome", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      { rpc: { listNotes: () => listNotesResult([]) } },
    );

    const toolbar = await slot.findByRole("toolbar", {
      name: "Notes sidebar actions",
    });
    slot.getByRole("navigation", { name: "Notes" });
    expect(slot.container.querySelector("aside")).toBeNull();
    expect(slot.queryByRole("separator")).toBeNull();
    expect(within(toolbar).getByRole("button", { name: "Search notes" })).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "New note" })).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "New folder" })).toBeTruthy();
  });

  it("keeps one shared request across page and navigation Strict Mode replay", async () => {
    let requests = 0;
    const StrictDocsSurfaces = (props: { subPath: string }) => (
      <StrictMode>
        <docsRegistration.component {...props} />
        <navigationView.component {...props} />
      </StrictMode>
    );
    const slot = renderSlot(
      { ...navigationRegistration, component: StrictDocsSurfaces },
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () => {
            requests += 1;
            return listNotesResult([]);
          },
        },
      },
    );

    await slot.findByRole("navigation", { name: "Notes" });
    await slot.findByText("Select a note or HTML page.");
    expect(requests).toBe(1);
  });

  it("shows an initial notebook error and lets the user retry", async () => {
    let requests = 0;
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () => {
            requests += 1;
            if (requests === 1) throw new Error("Host unavailable");
            return listNotesResult([]);
          },
        },
      },
    );

    await slot.findByText("Could not load vaults: Host unavailable");
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await slot.findByRole("navigation", { name: "Notes" });
    expect(requests).toBe(2);
  });

  it("keeps folder children together in the native navigation view", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [
                {
                  path: "projects/child.md",
                  title: "Child note",
                  preview: "",
                  modifiedAtMs: 2,
                },
                {
                  path: "projects.md",
                  title: "Sibling note",
                  preview: "",
                  modifiedAtMs: 1,
                },
              ],
              [
                { kind: "directory", path: "projects" },
                { kind: "file", path: "projects.md" },
                { kind: "file", path: "projects/child.md" },
              ],
            ),
        },
      },
    );

    await findTreeItem(slot.container, "child.md");
    const rows = treeItemLabels(slot.container);
    expect(rows.indexOf("child.md")).toBe(rows.indexOf("projects") + 1);
    expect(rows.indexOf("projects.md")).toBeGreaterThan(rows.indexOf("child.md"));
  });

  it("passes note paths with spaces to host navigation without pre-encoding", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "Tasks follow up apis.md",
                title: "Tasks follow up apis",
                preview: "",
                modifiedAtMs: 1,
              },
            ]),
        },
      },
    );

    fireEvent.click(await findTreeItem(slot.container, "Tasks follow up apis.md"));

    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: {
        subPath: "personal/Tasks follow up apis.md",
        replace: false,
      },
    });
  });

  it("syncs the editor workspace to vault changes from panel navigation and history", async () => {
    const panel = docsRegistration;
    const PanelContent = panel.component;
    const slot = renderSlot(
      panel,
      { subPath: "personal/one.md" },
      {
        rpc: {
          listNotes: (rawInput: unknown) => {
            const input = rawInput as { vaultId?: string } | undefined;
            const vaultId = input?.vaultId ?? "personal";
            const name = vaultId === "work" ? "Work" : "Personal";
            const path = vaultId === "work" ? "two.md" : "one.md";
            return {
              ...listNotesResult([
                {
                  path,
                  title: name,
                  preview: "",
                  modifiedAtMs: 1,
                },
              ]),
              vault: {
                id: vaultId,
                name,
                hostId: "host_local",
                rootPath: `/vaults/${vaultId}`,
              },
            };
          },
          readNote: (rawInput: unknown) => {
            const input = rawInput as { vaultId: string };
            return {
              content: `# ${input.vaultId === "work" ? "Work" : "Personal"}`,
              sha256: input.vaultId,
            };
          },
          preparePreview: () => preview,
          renameToTitle: (rawInput: unknown) => {
            const input = rawInput as { path: string };
            return { path: input.path };
          },
        },
      },
    );
    await slot.findByText("Personal");

    slot.rerender(<PanelContent subPath="work/two.md" />);
    await slot.findByText("Work");
    expect(slot.rpcCalls).toContainEqual({
      method: "readNote",
      input: { vaultId: "work", path: "two.md" },
    });

    slot.rerender(<PanelContent subPath="personal/one.md" />);
    await slot.findByText("Personal");
    expect(slot.rpcCalls).toContainEqual({
      method: "readNote",
      input: { vaultId: "personal", path: "one.md" },
    });
  });

  it("shares one notebook request across page and navigation mounts and vault events", async () => {
    type PendingNotebook = {
      vaultId: string;
      resolve: (value: ReturnType<typeof listNotesResult>) => void;
    };
    const pending: PendingNotebook[] = [];
    const notebook = (vaultId: string) => ({
      ...listNotesResult([
        {
          path: `${vaultId}.md`,
          title: vaultId === "work" ? "Work note" : "Personal note",
          preview: "",
          modifiedAtMs: 1,
        },
      ]),
      vaults: [
        {
          id: "personal",
          name: "Personal",
          hostId: "host_local",
          rootPath: "/vaults/personal",
        },
        {
          id: "work",
          name: "Work",
          hostId: "host_local",
          rootPath: "/vaults/work",
        },
      ],
      vault: {
        id: vaultId,
        name: vaultId === "work" ? "Work" : "Personal",
        hostId: "host_local",
        rootPath: `/vaults/${vaultId}`,
      },
    });
    const rpc = {
      listNotes: (rawInput: unknown) => {
        const input = rawInput as { vaultId?: string } | undefined;
        const vaultId = input?.vaultId ?? "personal";
        return new Promise<ReturnType<typeof listNotesResult>>((resolve) => {
          pending.push({ vaultId, resolve });
        });
      },
      readNote: (rawInput: unknown) => {
        const input = rawInput as { vaultId: string };
        return {
          content: `# ${input.vaultId === "work" ? "Work document" : "Personal document"}`,
          sha256: input.vaultId,
        };
      },
      preparePreview: () => preview,
      createNote: () => ({ path: "created.md" }),
      renameToTitle: (rawInput: unknown) => {
        const input = rawInput as { path: string };
        return { path: input.path };
      },
    };
    const page = renderSlot(docsRegistration, { subPath: "personal/personal.md" }, { rpc });
    const navigation = renderSlot(
      navigationRegistration,
      { subPath: "personal/personal.md" },
      { rpc },
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending.map((request) => request.vaultId)).toEqual(["personal"]);
    for (const request of pending.splice(0)) request.resolve(notebook("personal"));
    await page.findByText("Personal document");
    await findTreeItem(navigation.container, "personal.md");

    await page.emitRealtime("vault-changed", { vaultId: "personal" });
    await navigation.emitRealtime("vault-changed", { vaultId: "personal" });
    await waitFor(() => expect(pending).toHaveLength(1));
    const latePersonalRequests = pending.splice(0);
    expect(latePersonalRequests.map((request) => request.vaultId)).toEqual(["personal"]);

    page.rerender(<docsRegistration.component subPath="work/work.md" />);
    navigation.rerender(<navigationView.component subPath="work/work.md" />);
    expect(page.queryByText("Personal document")).toBeNull();
    expect(queryTreeItem(navigation.container, "personal.md")).toBeNull();
    await waitFor(() => expect(pending).toHaveLength(1));
    const workRequests = pending.splice(0);
    expect(workRequests.map((request) => request.vaultId)).toEqual(["work"]);
    for (const request of workRequests) request.resolve(notebook("work"));
    await page.findByText("Work document");
    await findTreeItem(navigation.container, "work.md");

    for (const request of latePersonalRequests) {
      request.resolve(notebook("personal"));
    }
    await act(async () => undefined);
    expect(page.queryByText("Personal document")).toBeNull();
    expect(queryTreeItem(navigation.container, "personal.md")).toBeNull();
    expect(page.getByText("Work document")).toBeTruthy();
    expect(queryTreeItem(navigation.container, "work.md")).toBeTruthy();

    fireEvent.click(navigation.getByRole("button", { name: "New note" }));
    await waitFor(() =>
      expect(navigation.rpcCalls).toContainEqual({
        method: "createNote",
        input: { vaultId: "work", parent: "", name: "Untitled" },
      }),
    );
  });

  it("runs one follow-up refresh when a vault changes during an active request", async () => {
    const requests: Array<{
      resolve(value: ReturnType<typeof listNotesResult>): void;
    }> = [];
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () =>
            new Promise<ReturnType<typeof listNotesResult>>((resolve) => {
              requests.push({ resolve });
            }),
        },
      },
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    await slot.emitRealtime("vault-changed", { vaultId: "personal" });
    expect(requests).toHaveLength(1);

    requests[0]!.resolve(
      listNotesResult([
        {
          path: "stale.md",
          title: "Stale note",
          preview: "",
          modifiedAtMs: 1,
        },
      ]),
    );
    await waitFor(() => expect(requests).toHaveLength(2));
    requests[1]!.resolve(
      listNotesResult([
        {
          path: "fresh.md",
          title: "Fresh note",
          preview: "",
          modifiedAtMs: 2,
        },
      ]),
    );

    await findTreeItem(slot.container, "fresh.md");
    expect(queryTreeItem(slot.container, "stale.md")).toBeNull();
  });

  it("renders a remounted vault listing from cache while it revalidates", async () => {
    const listNotes = vi
      .fn<() => unknown>()
      .mockReturnValueOnce(listNotesResultForVault("personal", "personal.md", "Personal note"))
      // The revalidation never answers: whatever shows next came from cache.
      .mockReturnValue(new Promise(() => {}));
    const rpc = { listNotes, preparePreview: () => preview };
    const first = renderSlot(navigationRegistration, { subPath: "personal" }, { rpc });
    await findTreeItem(first.container, "personal.md");
    first.unmount();

    const second = renderSlot(navigationRegistration, { subPath: "personal" }, { rpc });
    await findTreeItem(second.container, "personal.md");
    expect(listNotes).toHaveBeenCalledTimes(2);
  });

  it("reads a remounted listing again when its old request may predate an unheard change", async () => {
    const before = deferred<ReturnType<typeof listNotesResultForVault>>();
    const listNotes = vi
      .fn<() => unknown>()
      .mockReturnValueOnce(before.promise)
      .mockReturnValue(listNotesResultForVault("personal", "renamed.md", "Renamed note"));
    const rpc = { listNotes, preparePreview: () => preview };
    const first = renderSlot(navigationRegistration, { subPath: "personal" }, { rpc });
    await waitFor(() => expect(listNotes).toHaveBeenCalledTimes(1));
    first.unmount();
    // Nobody listens while the note is renamed and the old answer is on its way.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = renderSlot(navigationRegistration, { subPath: "personal" }, { rpc });
    before.resolve(listNotesResultForVault("personal", "personal.md", "Personal note"));
    await findTreeItem(second.container, "renamed.md");
    expect(listNotes).toHaveBeenCalledTimes(2);
  });

  it("ignores an obsolete vault refresh and rename after a deferred save", async () => {
    const pendingSave = deferred<{
      outcome: "written";
      sha256: string;
    }>();
    const pendingWorkNotebook = deferred<ReturnType<typeof listNotesResultForVault>>();
    let workNotebookRequested = false;
    const PanelContent = docsRegistration.component;
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/personal.md" },
      {
        rpc: {
          listNotes: (rawInput: unknown) => {
            const input = rawInput as { vaultId?: string } | undefined;
            if (input?.vaultId === "work") {
              workNotebookRequested = true;
              return pendingWorkNotebook.promise;
            }
            return listNotesResultForVault("personal", "personal.md", "Personal note");
          },
          readNote: (rawInput: unknown) => {
            const input = rawInput as { vaultId: string };
            return {
              content:
                input.vaultId === "work"
                  ? "# Work document\n\nWork body"
                  : "# Personal document\n\nPersonal body",
              sha256: input.vaultId,
            };
          },
          preparePreview: () => preview,
          saveNote: () => pendingSave.promise,
          renameToTitle: (rawInput: unknown) => {
            const input = rawInput as { vaultId: string; path: string };
            return {
              path: input.vaultId === "personal" ? "personal-renamed.md" : input.path,
            };
          },
        },
      },
    );
    const body = await slot.findByText("Personal body");
    body.textContent = "Edited personal body";
    fireEvent.input(body);
    await waitFor(
      () => expect(slot.rpcCalls.some((call) => call.method === "saveNote")).toBe(true),
      { timeout: 2_000 },
    );

    slot.rerender(<PanelContent subPath="work/work.md" />);
    await waitFor(() => expect(workNotebookRequested).toBe(true));
    await act(async () => {
      pendingSave.resolve({ outcome: "written", sha256: "saved-personal" });
    });
    pendingWorkNotebook.resolve(listNotesResultForVault("work", "work.md", "Work note"));

    await slot.findByText("Work body");
    expect(
      slot.rpcCalls.filter(
        (call) =>
          call.method === "listNotes" &&
          (call.input as { vaultId?: string }).vaultId === "personal",
      ),
    ).toHaveLength(1);
    expect(slot.navigateCalls).not.toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: {
        subPath: "personal/personal-renamed.md",
        replace: true,
      },
    });
  });

  it("ignores obsolete refresh and navigation after deferred note creation", async () => {
    const pendingCreate = deferred<{ path: string }>();
    const pendingWorkNotebook = deferred<ReturnType<typeof listNotesResultForVault>>();
    let workNotebookRequested = false;
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal/personal.md" },
      {
        rpc: {
          listNotes: (rawInput: unknown) => {
            const input = rawInput as { vaultId?: string } | undefined;
            if (input?.vaultId === "work") {
              workNotebookRequested = true;
              return pendingWorkNotebook.promise;
            }
            return listNotesResultForVault("personal", "personal.md", "Personal note");
          },
          createNote: () => pendingCreate.promise,
        },
      },
    );
    await findTreeItem(slot.container, "personal.md");
    fireEvent.click(slot.getByRole("button", { name: "New note" }));
    await waitFor(() =>
      expect(slot.rpcCalls.some((call) => call.method === "createNote")).toBe(true),
    );

    slot.rerender(<navigationView.component subPath="work/work.md" />);
    await waitFor(() => expect(workNotebookRequested).toBe(true));
    await act(async () => {
      pendingCreate.resolve({ path: "created-in-personal.md" });
    });
    pendingWorkNotebook.resolve(listNotesResultForVault("work", "work.md", "Work note"));

    await findTreeItem(slot.container, "work.md");
    expect(
      slot.rpcCalls.filter(
        (call) =>
          call.method === "listNotes" &&
          (call.input as { vaultId?: string }).vaultId === "personal",
      ),
    ).toHaveLength(1);
    expect(slot.navigateCalls).not.toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: {
        subPath: "personal/created-in-personal.md",
        replace: false,
      },
    });
  });

  it("only shows host status when the selected vault is unavailable", async () => {
    const available = listNotesResult([]);
    const unavailable = {
      ...available,
      vault: { ...available.vault, hostId: "host_remote" },
      vaults: [{ ...available.vault, hostId: "host_remote" }],
      hosts: [{ id: "host_remote", name: "Remote Mac", status: "disconnected" }],
    };
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      { rpc: { listNotes: () => unavailable } },
    );

    await slot.findByText("Host unavailable");
    expect(slot.queryByText("Remote Mac")).toBeNull();
  });

  it("offers another machine when the folder is missing but not while its host is away", async () => {
    const base = listNotesResult([]);
    const obsidian = {
      id: "obsidian",
      name: "Obsidian",
      hostId: "host_mac",
      rootPath: "/Users/me/obsidian-vault",
    };
    let macStatus = "disconnected";
    let error = "Host is not connected";
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "obsidian" },
      {
        rpc: {
          listNotes: () => ({
            ...base,
            vaults: [obsidian],
            vault: obsidian,
            hosts: [
              { id: "host_mac", name: "Local Mac", status: macStatus },
              { id: "host_dev", name: "Build Mac", status: "connected" },
            ],
            error,
          }),
        },
      },
    );

    await slot.findByText("Host is not connected");
    expect(slot.queryByRole("combobox", { name: "Vault machine" })).toBeNull();

    macStatus = "connected";
    error = "Folder not found: /Users/me/obsidian-vault";
    await slot.emitRealtime("vault-changed", { vaultId: "obsidian" });
    await slot.findByText("Folder not found: /Users/me/obsidian-vault");
    expect(slot.getByRole("combobox", { name: "Vault machine" })).toBeTruthy();
  });

  it("asks which machine holds a vault saved without one and binds it there", async () => {
    // jsdom has no scrollIntoView; Radix Select scrolls the highlighted option.
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    onTestFinished(() => {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });
    const base = listNotesResult([]);
    const obsidian = {
      id: "obsidian",
      name: "Obsidian",
      hostId: null,
      rootPath: "/Users/me/obsidian-vault",
    };
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "obsidian" },
      {
        rpc: {
          listNotes: () => ({
            ...base,
            vaults: [obsidian],
            vault: obsidian,
            hosts: [
              { id: "host_server", name: "linux-builder", status: "connected" },
              { id: "host_mac", name: "Local Mac", status: "connected" },
            ],
            error:
              "Choose the machine that holds /Users/me/obsidian-vault for the Obsidian vault (found on Local Mac), or run bb docs vault-host obsidian <host-id>.",
          }),
          setVaultHost: () => ({ ...obsidian, hostId: "host_mac" }),
        },
      },
    );

    await slot.findByText(/Choose the machine that holds \/Users\/me\/obsidian-vault/);
    const use = slot.getByRole("button", { name: "Use machine" });
    expect(use.hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(slot.getByRole("combobox", { name: "Vault machine" }), { key: "Enter" });
    fireEvent.click(await slot.findByRole("option", { name: "Local Mac · connected" }));
    await waitFor(() => expect(use.hasAttribute("disabled")).toBe(false));
    fireEvent.click(use);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "setVaultHost",
        input: { vaultId: "obsidian", hostId: "host_mac" },
      }),
    );
  });

  it("adds a vault on a named machine instead of an implicit server machine", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        sdk: { system: { config: async () => ({ primaryHostId: "host_server" }) as never } },
        rpc: {
          listNotes: () => ({
            ...listNotesResult([]),
            hosts: [
              { id: "host_server", name: "linux-builder", status: "connected" },
              { id: "host_mac", name: "Local Mac", status: "connected" },
            ],
          }),
          createVault: () => ({
            id: "work",
            name: "Work",
            hostId: "host_server",
            rootPath: "/srv/work",
          }),
        },
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Add vault" }));
    expect(slot.queryByText("Server machine")).toBeNull();
    await slot.findByText("linux-builder · bb server · connected");
    fireEvent.change(slot.getByLabelText("Name"), { target: { value: "Work" } });
    fireEvent.change(slot.getByPlaceholderText("Absolute path on that machine"), {
      target: { value: "/srv/work" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Add vault", hidden: false }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "createVault",
        input: { name: "Work", rootPath: "/srv/work", hostId: "host_server" },
      }),
    );
  });

  it("keeps task checkboxes aligned with the first line of their text", async () => {
    const existingStyles = document.head.querySelector("style[data-bb-simple-notes-styles]");
    if (existingStyles) existingStyles.textContent = "stale editor styles";
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/tasks.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "tasks.md",
                title: "Tasks",
                preview: "One task",
                modifiedAtMs: 1,
              },
            ]),
          readNote: () => ({
            content: "- [x] One task\n  - [ ] Nested task",
            sha256: "sha",
          }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "tasks.md" }),
        },
      },
    );

    await slot.findByText("One task");
    expect(slot.queryByRole("button", { name: "Add image" })).toBeNull();
    expect(slot.container.querySelector('input[type="file"]')).toBeNull();
    const styles = document.head.querySelector("style[data-bb-simple-notes-styles]");
    expect(styles?.textContent).not.toBe("stale editor styles");
    expect(styles?.textContent).toContain("align-items: flex-start");
    expect(styles?.textContent).toContain("height: 1.625em");
    expect(styles?.textContent).toContain("cursor: pointer; margin: 0");
    expect(styles?.textContent).toContain('ul[data-type="taskList"] li > div > p { margin: 0; }');
  });

  it("renders and autosaves editable Markdown tables", async () => {
    const saveNote = vi.fn((_input: unknown) => ({
      outcome: "written",
      sha256: "next-sha",
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/status.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "status.md",
                title: "Status",
                preview: "Docs Ready",
                modifiedAtMs: 1,
              },
            ]),
          readNote: () => ({
            content: "# Status\n\n| Project | State |\n| --- | --- |\n| Docs | Ready |",
            sha256: "sha",
          }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "status.md" }),
          saveNote,
        },
      },
    );

    await slot.findByText("Ready");
    const table = slot.container.querySelector("table");
    expect(table).toBeTruthy();
    expect(table?.querySelector("th")?.textContent).toBe("Project");
    expect(table?.querySelector("td")?.textContent).toBe("Docs");
    expect(table?.closest(".tableWrapper")).toBeTruthy();
    expect(table?.closest('[contenteditable="true"]')).toBeTruthy();

    const styles = document.head.querySelector("style[data-bb-simple-notes-styles]");
    expect(styles?.textContent).toContain("column-resize-handle");

    const firstBodyCell = table?.querySelector("td p");
    expect(firstBodyCell).toBeTruthy();
    firstBodyCell!.textContent = "Plans";
    fireEvent.input(firstBodyCell!);
    await waitFor(() => expect(saveNote).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(saveNote.mock.calls.at(-1)?.[0]).toMatchObject({
      content: expect.stringContaining("| Plans | Ready |"),
    });
  });

  it("hides and preserves YAML frontmatter when editing a document", async () => {
    const frontmatter = ["---\r\n", "title: Wiki page\r\n", "type: knowledge\r\n", "---\r\n"].join(
      "",
    );
    const saveNote = vi.fn((_input: unknown) => ({
      outcome: "written",
      sha256: "next-sha",
    }));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/wiki-page.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "wiki-page.md",
                title: "Wiki page",
                preview: "Original body.",
                modifiedAtMs: 1,
              },
            ]),
          readNote: () => ({
            content: `${frontmatter}\r\n# Wiki page\r\n\r\nOriginal body.`,
            sha256: "sha",
          }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "wiki-page.md" }),
          saveNote,
        },
      },
    );

    const body = await slot.findByText("Original body.");
    const editor = slot.container.querySelector(".tiptap");
    expect(editor?.textContent).not.toContain("type: knowledge");
    expect(editor?.querySelector("hr")).toBeNull();

    body.textContent = "Edited body.";
    fireEvent.input(body);
    await waitFor(() => expect(saveNote).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(saveNote.mock.calls.at(-1)?.[0]).toMatchObject({
      content: expect.stringMatching(
        /^---\r\ntitle: Wiki page\r\ntype: knowledge\r\n---\r\n\r\n# Wiki page\n\nEdited body\./,
      ),
    });
  });

  it("keeps a leading thematic break visible in the editor", async () => {
    const content = "---\n\nSome intro text.\n\n---\n\nMore text.\n";
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/break.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "break.md",
                title: "Break doc",
                preview: "Some intro text. More text.",
                modifiedAtMs: 1,
              },
            ]),
          readNote: () => ({ content, sha256: "sha" }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "break.md" }),
          saveNote: () => ({ outcome: "written", sha256: "next-sha" }),
        },
      },
    );

    await waitFor(() => {
      const editor = slot.container.querySelector(".tiptap");
      expect(editor?.textContent).toContain("Some intro text.");
      expect(editor?.textContent).toContain("More text.");
    });
  });

  it("renders nested folders, images, and sandboxed HTML directives", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/projects/article.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [
                {
                  path: "projects/article.md",
                  title: "Article",
                  preview: "A typeset note",
                  modifiedAtMs: Date.now(),
                },
              ],
              [
                { kind: "directory", path: "projects" },
                { kind: "file", path: "projects/article.md" },
                { kind: "file", path: "projects/report.html" },
              ],
            ),
          readNote: () => ({
            content:
              '# Article\n\n![Sketch](./_attachments/sketch.png)\n\n::html{src="./report.html" height="240"}\n\n## After the embed',
            sha256: "sha-1",
          }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "projects/article.md" }),
        },
      },
    );

    await slot.findByText("Article");
    await waitFor(() => {
      const image = slot.container.querySelector("img");
      expect(image?.getAttribute("src")).toBe(
        "/api/v1/file-previews/lease/projects/_attachments/sketch.png",
      );
      const iframe = slot.container.querySelector("iframe");
      expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(iframe?.getAttribute("src")).toBe("/api/v1/file-previews/lease/projects/report.html");
      expect(slot.container.querySelector("h2")?.textContent).toBe("After the embed");
    });
  });

  it("creates a note inside the currently selected folder", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal/projects/existing.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [
                {
                  path: "projects/existing.md",
                  title: "Existing",
                  preview: "",
                  modifiedAtMs: 1,
                },
              ],
              [
                { kind: "directory", path: "projects" },
                { kind: "file", path: "projects/existing.md" },
              ],
            ),
          readNote: () => ({ content: "# Existing", sha256: "sha" }),
          preparePreview: () => preview,
          createNote: () => ({ path: "projects/Untitled.md" }),
          renameToTitle: () => ({ path: "projects/existing.md" }),
        },
      },
    );

    await findTreeItem(slot.container, "existing.md");
    fireEvent.click(slot.getByLabelText("New note"));

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "createNote",
        input: { vaultId: "personal", parent: "projects", name: "Untitled" },
      });
    });
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "personal/projects/Untitled.md", replace: false },
    });
  });

  it("deletes a file directly from its context menu", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal/projects/old.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [
                {
                  path: "projects/old.md",
                  title: "Old note",
                  preview: "",
                  modifiedAtMs: 1,
                },
              ],
              [
                { kind: "directory", path: "projects" },
                { kind: "file", path: "projects/old.md" },
              ],
            ),
          readNote: () => ({ content: "# Old note", sha256: "sha" }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "projects/old.md" }),
          deletePath: () => ({ ok: true }),
        },
      },
    );

    const file = await findTreeItem(slot.container, "old.md");
    fireEvent.contextMenu(file);
    fireEvent.click(await slot.findByRole("menuitem", { name: "Delete" }));

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "deletePath",
        input: { vaultId: "personal", path: "projects/old.md" },
      });
    });
    expect(slot.queryByText("Delete file?")).toBeNull();
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "personal", replace: true },
    });
  });

  it("moves a file when it is dropped onto a folder", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal/old.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [
                {
                  path: "old.md",
                  title: "Old note",
                  preview: "",
                  modifiedAtMs: 1,
                },
              ],
              [
                { kind: "directory", path: "projects" },
                { kind: "file", path: "old.md" },
              ],
            ),
          readNote: () => ({ content: "# Old note", sha256: "sha" }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "old.md" }),
          movePath: () => ({ path: "projects/old.md" }),
        },
      },
    );

    const file = await findTreeItem(slot.container, "old.md");
    const folder = await findTreeItem(slot.container, "projects");
    folder.getBoundingClientRect = () => new DOMRect(0, 0, 100, 28);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => folder),
    });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(file, { clientX: 1, clientY: 1, dataTransfer });
    fireEvent.dragOver(folder, { clientX: 1, clientY: 1, dataTransfer });
    fireEvent.drop(folder, { clientX: 1, clientY: 1, dataTransfer });

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "movePath",
        input: {
          vaultId: "personal",
          from: "old.md",
          to: "projects/old.md",
        },
      });
    });
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: {
        subPath: "personal/projects/old.md",
        replace: true,
      },
    });
  });

  it("moves a nested file back to the top level", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal/projects/old.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [
                {
                  path: "projects/old.md",
                  title: "Old note",
                  preview: "",
                  modifiedAtMs: 1,
                },
                {
                  path: "root.md",
                  title: "Root note",
                  preview: "",
                  modifiedAtMs: 1,
                },
              ],
              [
                { kind: "directory", path: "projects" },
                { kind: "file", path: "projects/old.md" },
                { kind: "file", path: "root.md" },
              ],
            ),
          readNote: () => ({ content: "# Old note", sha256: "sha" }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "projects/old.md" }),
          movePath: () => ({ path: "old.md" }),
        },
      },
    );

    const file = await findTreeItem(slot.container, "old.md");
    const topLevel = await findTreeItem(slot.container, "root.md");
    topLevel.getBoundingClientRect = () => new DOMRect(0, 0, 100, 28);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => topLevel),
    });
    const dataTransfer = makeDataTransfer();
    fireEvent.dragStart(file, { clientX: 1, clientY: 1, dataTransfer });
    fireEvent.dragOver(topLevel, { clientX: 1, clientY: 1, dataTransfer });
    fireEvent.drop(topLevel, { clientX: 1, clientY: 1, dataTransfer });

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "movePath",
        input: {
          vaultId: "personal",
          from: "projects/old.md",
          to: "old.md",
        },
      });
    });
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "personal/old.md", replace: true },
    });
  });

  it("opens HTML Docs directive cards in the thread panel or full editor", () => {
    const openTab = vi.fn(() => true);
    const slot = renderDocument("plans/release.html", "Release plan", {
      experimental_panel: { openTab },
    });

    fireEvent.click(slot.getByText("Release plan"));
    expect(slot.queryByText("personal · plans/release.html")).toBeNull();
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "document", context: { kind: "thread" }, availability: "action" },
      title: "Release plan",
      params: {
        vaultId: "personal",
        path: "plans/release.html",
        title: "Release plan",
      },
    });

    fireEvent.click(slot.getByRole("button", { name: "Open in Docs" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "personal/plans/release.html" },
    });
  });

  it("skips its own save's echo and changes to other notes", async () => {
    const readNote = vi
      .fn<() => Promise<{ content: string; sha256: string }>>()
      .mockResolvedValue({ content: "Original paragraph.", sha256: "original-sha" });
    const slot = renderDocument("echo.md", "Echo", { rpc: { readNote } });
    await slot.findByText("Original paragraph.");
    const reads = () => readNote.mock.calls.length;
    const before = reads();

    await slot.emitRealtime("vault-changed", {
      vaultId: "personal",
      path: "echo.md",
      sha256: "original-sha",
    });
    await slot.emitRealtime("vault-changed", { vaultId: "personal", paths: ["other.md"] });
    expect(reads()).toBe(before);

    await slot.emitRealtime("vault-changed", { vaultId: "personal", paths: ["echo.md"] });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("re-reads a note when a folder holding it changes", async () => {
    const readNote = vi
      .fn<() => Promise<{ content: string; sha256: string }>>()
      .mockResolvedValue({ content: "Inside a folder.", sha256: "folder-sha" });
    const slot = renderDocument("notes/plan.md", "Plan", { rpc: { readNote } });
    await slot.findByText("Inside a folder.");
    const reads = () => readNote.mock.calls.length;
    const before = reads();

    await slot.emitRealtime("vault-changed", { vaultId: "personal", paths: ["note"] });
    expect(reads()).toBe(before);

    await slot.emitRealtime("vault-changed", { vaultId: "personal", paths: ["notes"] });
    await waitFor(() => expect(reads()).toBe(before + 1));
  });

  it("shows cached document content immediately when returning to a thread", async () => {
    const file = { content: "Keep this draft visible.", sha256: "saved-sha" };
    const readNote = vi.fn<() => Promise<typeof file>>().mockResolvedValue(file);
    const render = () =>
      renderDocument("cached-draft.md", "Cached draft", {
        rpc: {
          readNote,
        },
      });
    const first = render();
    await first.findByText(file.content);
    await act(async () => {
      first.unmount();
    });
    let finish!: (result: typeof file) => void;
    readNote.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const returned = render();
    try {
      expect(returned.getByRole("textbox", { name: "Document content" }).textContent).toContain(
        file.content,
      );
    } finally {
      await act(async () => {
        finish({
          ...file,
          content: "Fresh content from disk.",
          sha256: "new-sha",
        });
      });
    }
    await returned.findByText("Fresh content from disk.");
  });

  it("truncates tall inline documents and restores editing when they shrink", async () => {
    let height = 600;
    let resize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(() => new DOMRect(0, 0, 600, height));
    const openTab = vi.fn(() => true);
    try {
      const slot = renderDocument("tall-inline.md", "Tall document", {
        experimental_panel: { openTab },
        rpc: {
          readNote: () => ({ content: "A long document.", sha256: "tall-sha" }),
        },
      });
      const button = await slot.findByRole("button", {
        name: "Open Tall document in tab",
      });
      const editor = slot.getByRole("textbox", { name: "Document content" });
      await waitFor(() => {
        expect(editor.getAttribute("contenteditable")).toBe("false");
      });
      fireEvent.click(button);
      expect(openTab).toHaveBeenCalledWith({
        tab: { id: "document", context: { kind: "thread" }, availability: "action" },
        title: "Tall document",
        params: {
          vaultId: "personal",
          path: "tall-inline.md",
          title: "Tall document",
        },
      });
      await act(async () => {
        height = 200;
        resize();
      });
      expect(slot.queryByRole("button", { name: "Open Tall document in tab" })).toBeNull();
      await waitFor(() => {
        expect(editor.getAttribute("contenteditable")).toBe("true");
      });
    } finally {
      bounds.mockRestore();
    }
  });

  it("edits Markdown inline and opens the same document in a tab", async () => {
    const openTab = vi.fn(() => true);
    const slot = renderDocument("inline-header.md", "Inline header", {
      experimental_panel: { openTab },
    });
    const editor = await slot.findByRole("textbox", {
      name: "Document content",
    });
    expect(editor.getAttribute("contenteditable")).toBe("true");
    fireEvent.focus(editor);
    expect(slot.queryByText("Editing")).toBeNull();
    expect(slot.queryByText("Saved")).toBeNull();
    expect(slot.container.querySelectorAll("header")).toHaveLength(1);
    expect(slot.container.querySelector("footer")).toBeNull();
    expect(slot.getByRole("button", { name: "Ask for changes" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Open in tab" }));
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "document", context: { kind: "thread" }, availability: "action" },
      title: "Inline header",
      params: {
        vaultId: "personal",
        path: "inline-header.md",
        title: "Inline header",
      },
    });
  });

  it("preserves the composer draft and attaches the document when asking for changes", async () => {
    const slot = renderDocument("ask-inline.md", "Launch email", {
      composer: { text: "Keep this instruction." },
      rpc: {
        readNote: () => ({ content: "Email body.", sha256: "original-sha" }),
      },
    });
    await slot.findByRole("textbox", { name: "Document content" });
    fireEvent.click(slot.getByRole("button", { name: "Ask for changes" }));
    await waitFor(() =>
      expect(slot.inspection.composer.draft.mentions).toEqual([
        expect.objectContaining({
          provider: "note",
          id: "personal:ask-inline.md",
          label: "Launch email",
        }),
      ]),
    );
    expect(slot.inspection.composer.text).toBe("Keep this instruction.\n\nUpdate @Launch email ");
    const [mention] = slot.inspection.composer.draft.mentions;
    expect(slot.inspection.composer.text.slice(mention!.from, mention!.to)).toBe("@Launch email");
    expect(slot.inspection.composer.focusCount).toBeGreaterThan(0);
  });

  it("copies the document through the host clipboard", async () => {
    const slot = renderDocument("copy-inline.md", "Launch email", {
      rpc: {
        readNote: () => ({ content: "Email body.", sha256: "original-sha" }),
      },
    });
    await slot.findByRole("textbox", { name: "Document content" });
    fireEvent.click(slot.getByRole("button", { name: "Copy" }));
    await waitFor(() =>
      expect(slot.inspection.experimental_clipboardWrites).toEqual([
        expect.objectContaining({ text: expect.stringContaining("Email body.") }),
      ]),
    );
  });

  it.each(["reject", "redo"] as const)(
    "keeps Ask and progress available through %s and restores proposal controls",
    async (action) => {
      const pending = {
        vaultId: "personal",
        path: `${action}-inline.md`,
        version: action === "reject" ? 1 : 3,
        baseContent: "Original paragraph.",
        baseSha256: "original-sha",
        content: "Revised paragraph.",
        status: action === "reject" ? "pending" : "undone",
        resolvedSha256: action === "reject" ? null : "original-sha",
      };
      let resolution = deferred<void>();
      const resolveProposal = vi
        .fn()
        .mockImplementationOnce(async () => {
          await resolution.promise;
          return {
            ...pending,
            version: pending.version + 1,
            status: action === "reject" ? "rejected" : "pending",
          };
        })
        .mockImplementationOnce(async () => {
          await resolution.promise;
          return {
            ...pending,
            version: pending.version + 2,
            status: "pending",
          };
        });
      const slot = renderDocument(pending.path, "Proposal", {
        rpc: { readProposal: () => pending, resolveProposal },
      });
      const steps = action === "reject" ? ["Reject", "Undo"] : ["Redo"];
      for (const [index, label] of steps.entries()) {
        const button = await slot.findByRole("button", { name: label });
        expect(button.textContent).toBe("");
        expect(slot.getByRole("button", { name: "Ask for changes" })).toBeTruthy();
        resolution = deferred<void>();
        fireEvent.click(button);
        expect((await slot.findByRole("status")).textContent).toBe("Updating document…");
        expect(button.hasAttribute("disabled")).toBe(true);
        expect(slot.getByRole("textbox", { name: "Document content" })).toBeTruthy();
        await act(async () => resolution.resolve());
        expect(slot.queryByRole("status")).toBeNull();
        expect(resolveProposal).toHaveBeenLastCalledWith({
          vaultId: "personal",
          path: pending.path,
          action: label.toLowerCase(),
          expectedVersion: pending.version + index,
        });
        if (label === "Reject") expect(slot.queryByRole("button", { name: "Accept" })).toBeNull();
      }
      expect(slot.getByRole("button", { name: "Accept" })).toBeTruthy();
      expect(slot.getByRole("button", { name: "Reject" })).toBeTruthy();
      expect(slot.getByRole("button", { name: "Ask for changes" })).toBeTruthy();
    },
  );

  it("parses rich proposal baselines in an inert document and scopes refreshes", async () => {
    const parse = vi.spyOn(ProseMirrorDOMParser.prototype, "parse");
    const pending = {
      vaultId: "personal",
      path: "scoped-inline.md",
      version: 1,
      baseContent: "<p>Original <strong>formatted baseline</strong>.</p>",
      baseSha256: "original-sha",
      content: "Revised **formatted baseline**.",
      status: "pending",
      resolvedSha256: null,
    };
    const readNote = vi.fn(() => ({
      content: pending.baseContent,
      sha256: "original-sha",
    }));
    const slot = renderDocument(pending.path, "Scoped example", {
      rpc: {
        readNote,
        readProposal: () => pending,
      },
    });
    await slot.findByRole("textbox", { name: "Document content" });
    const baselines = parse.mock.calls
      .map(([root]) => root)
      .filter((root) => root.textContent?.includes("Original formatted baseline"));
    expect(baselines.length).toBeGreaterThan(0);
    for (const root of baselines) expect(root.ownerDocument?.defaultView).toBeNull();
    expect(slot.container.querySelector("strong")?.textContent).toBe("formatted baseline");
    parse.mockRestore();
    readNote.mockClear();
    await slot.emitRealtime("vault-changed", { vaultId: "other" });
    await slot.emitRealtime("vault-changed", {
      vaultId: "personal",
      path: "other.md",
    });
    await slot.emitRealtime("proposal-changed", {
      vaultId: "personal",
      path: "other.md",
      version: 2,
    });
    await slot.emitRealtime("vault-changed", {
      vaultId: "personal",
      path: pending.path,
      proposalOnly: true,
    });
    expect(readNote).not.toHaveBeenCalled();
    await slot.emitRealtime("proposal-changed", {
      vaultId: "personal",
      path: pending.path,
      version: 2,
    });
    await waitFor(() => expect(readNote).toHaveBeenCalledTimes(1));
    await slot.emitRealtime("vault-changed", {
      vaultId: "personal",
      path: pending.path,
    });
    await waitFor(() => expect(readNote).toHaveBeenCalledTimes(2));
    await slot.emitRealtime("vault-changed", {});
    await waitFor(() => expect(readNote).toHaveBeenCalledTimes(3));
  });

  it("opens a chosen document from the unconfigured Document panel", async () => {
    const openTab = vi.fn(() => true);
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      { threadId: "thr_1", environment: null, params: null },
      {
        experimental_panel: { openTab },
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "Launch 50%.md",
                title: "Launch 50%",
                preview: "A draft",
                modifiedAtMs: 1,
              },
            ]),
        },
      },
    );
    fireEvent.click(await findTreeItem(slot.container, "Launch 50%.md"));
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "document", context: { kind: "thread" }, availability: "action" },
      title: "Launch 50%",
      params: {
        vaultId: "personal",
        path: "Launch 50%.md",
        title: "Launch 50%",
      },
    });
    expect(slot.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
  });

  it("renders a linked Markdown document in the Docs thread panel", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      {
        threadId: "thr_1",
        environment: null,
        params: {
          vaultId: "personal",
          path: "plans/panel-release.md",
          title: "Release plan",
        },
      },
      {
        rpc: {
          readNote: () => ({
            content: "# Release plan\n\nShip it.",
            sha256: "sha",
          }),
          readProposal: () => null,
          preparePreview: () => preview,
        },
      },
    );

    await slot.findByText("Ship it.");
    expect(slot.getAllByText("Release plan")).toHaveLength(2);
    expect(slot.getByRole("button", { name: "Ask for changes" })).toBeTruthy();
    expect(slot.queryByText("plans/panel-release.md")).toBeNull();
    expect(slot.getByRole("textbox").getAttribute("contenteditable")).toBe("true");
    expect(slot.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Mention in chat" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Open in Docs" })).toBeNull();
  });

  it("preserves the file opener host through autosave, conflict overwrite, and reload", async () => {
    let conflict = true;
    const slot = renderSlot(
      app.fileOpeners[0]!,
      {
        path: "/Users/shared/notes/plan.md",
        source: {
          kind: "host",
          threadId: "thr_1",
          environmentId: null,
          projectId: "project_1",
          experimental_hostId: "host_remote",
        },
        Original: () => null,
      },
      {
        rpc: {
          openFile: () => ({
            file: { content: "# Remote plan", sha256: "sha" },
            preview,
            previewPath: "notes/plan.md",
          }),
          saveOpenedFile: () =>
            conflict
              ? { outcome: "conflict", currentSha256: "remote-sha" }
              : { outcome: "written", sha256: "updated-sha" },
        },
      },
    );

    const body = await slot.findByText("Remote plan");
    expect(slot.rpcCalls).toContainEqual({
      method: "openFile",
      input: {
        source: {
          kind: "host",
          threadId: "thr_1",
          environmentId: null,
          projectId: "project_1",
          experimental_hostId: "host_remote",
        },
        path: "/Users/shared/notes/plan.md",
      },
    });

    body.textContent = "Updated remote plan";
    fireEvent.input(body);
    await waitFor(
      () => {
        expect(slot.rpcCalls).toContainEqual({
          method: "saveOpenedFile",
          input: {
            source: {
              kind: "host",
              threadId: "thr_1",
              environmentId: null,
              projectId: "project_1",
              experimental_hostId: "host_remote",
            },
            path: "/Users/shared/notes/plan.md",
            content: "# Updated remote plan",
            expectedSha256: "sha",
          },
        });
      },
      { timeout: 2_000 },
    );
    await slot.findByText("Changed on disk.");
    conflict = false;
    fireEvent.click(slot.getByRole("button", { name: "Overwrite" }));
    await waitFor(() => expect(slot.queryByText("Changed on disk.")).toBeNull());
    const writes = slot.rpcCalls.filter((call) => call.method === "saveOpenedFile");
    expect(writes).toHaveLength(2);
    expect(writes[1]?.input).toEqual({
      source: {
        kind: "host",
        threadId: "thr_1",
        environmentId: null,
        projectId: "project_1",
        experimental_hostId: "host_remote",
      },
      path: "/Users/shared/notes/plan.md",
      content: "# Updated remote plan",
    });
    conflict = true;
    const updated = slot.getByText("Updated remote plan");
    updated.textContent = "Discard this edit";
    fireEvent.input(updated);
    await slot.findByText("Changed on disk.");
    fireEvent.click(slot.getByRole("button", { name: "Reload" }));
    await slot.findByText("Remote plan");
    expect(slot.queryByText("Discard this edit")).toBeNull();
    expect(slot.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Mention in chat" })).toBeNull();
  });

  it.each(["workspace", "panel"])("opens sandboxed HTML in the %s", async (surface) => {
    const path = "dashboards/metrics.html";
    const options = {
      rpc: {
        listNotes: () =>
          listNotesResult(
            [],
            [
              { kind: "directory", path: "dashboards" },
              { kind: "file", path },
            ],
          ),
        preparePreview: () => preview,
      },
    } satisfies RenderSlotOptions;
    const slot =
      surface === "panel"
        ? renderSlot(
            app.threadPanelActions[0]!,
            {
              threadId: "thr_1",
              environment: null,
              params: { vaultId: "personal", path, title: "Metrics" },
            },
            options,
          )
        : renderSlot(docsRegistration, { subPath: `personal/${path}` }, options);
    await waitFor(() => {
      const iframe = slot.container.querySelector("iframe");
      expect(iframe?.getAttribute("src")).toBe(`/api/v1/file-previews/lease/${path}`);
      expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
      expect(iframe?.title).toBe(surface === "panel" ? "Metrics" : path);
      expect(iframe?.classList.contains(surface === "panel" ? "min-h-[32rem]" : "min-h-0")).toBe(
        true,
      );
    });
    expect(slot.queryByRole("button", { name: "View source" })).toBeNull();
  });

  it("filters the vault tree by note title", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "roadmap.md",
                title: "Roadmap",
                preview: "Quarterly priorities",
                modifiedAtMs: 2,
              },
              {
                path: "meeting.md",
                title: "Meeting",
                preview: "Launch checklist",
                modifiedAtMs: 1,
              },
            ]),
        },
      },
    );

    await findTreeItem(slot.container, "roadmap.md");
    expect(slot.queryByText("Primary host")).toBeNull();
    const vault = slot.getByRole("combobox", { name: "Vault" });
    expect(vault.closest("aside")).toBeNull();
    expect(slot.queryByPlaceholderText("Search this vault")).toBeNull();
    fireEvent.click(slot.getByLabelText("Search notes"));
    fireEvent.change(slot.getByPlaceholderText("Search this vault"), {
      target: { value: "meeting" },
    });
    await waitFor(() => {
      expect(queryTreeItem(slot.container, "roadmap.md")).toBeNull();
      expect(queryTreeItem(slot.container, "meeting.md")).toBeTruthy();
    });
    fireEvent.keyDown(slot.getByPlaceholderText("Search this vault"), {
      key: "Escape",
    });
    expect(slot.queryByPlaceholderText("Search this vault")).toBeNull();
    await findTreeItem(slot.container, "roadmap.md");
  });

  it("renders editable Markdown using the shared stream presentation", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/theme.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              { path: "theme.md", title: "Theme", preview: "Styled document", modifiedAtMs: 1 },
            ]),
          readNote: () => ({
            content: "# Theme\n\n**Strong** and [linked](https://example.com).",
            sha256: "sha",
          }),
          readProposal: () => null,
          preparePreview: () => preview,
        },
      },
    );

    await slot.findByText("Strong");
    const editor = slot.container.querySelector(".tiptap.bb-markdown-prose");
    expect(editor?.getAttribute("contenteditable")).toBe("true");
    expect(editor?.querySelector("h1")?.textContent).toBe("Theme");
    expect(editor?.querySelector("strong")?.textContent).toBe("Strong");
    expect(editor?.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  it("opens MDX vault entries through bb's file opener", async () => {
    const openFilePreview = vi.fn(() => true);
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        openFilePreview,
        rpc: {
          listNotes: () =>
            listNotesResult(
              [{ path: "notes.md", title: "Notes", preview: "", modifiedAtMs: 1 }],
              [
                { kind: "file", path: "notes.md" },
                { kind: "file", path: "plans/board.canvas.mdx" },
                { kind: "directory", path: "plans" },
              ],
            ),
        },
      },
    );

    fireEvent.click(await findTreeItem(slot.container, "board.canvas.mdx"));
    await waitFor(() =>
      expect(openFilePreview).toHaveBeenCalledWith({
        target: {
          kind: "host",
          hostId: "host_local",
          path: "/Users/me/Notes/plans/board.canvas.mdx",
        },
        location: null,
      }),
    );
    expect(slot.navigateCalls.some((call) => call.method === "toPluginPanel")).toBe(false);
  });

  it("links a thread's host file to the machine the server resolved", async () => {
    const openFileExternally = vi.fn(() => true);
    const source = {
      kind: "host" as const,
      threadId: "thr_1",
      environmentId: "env_mac",
      projectId: null,
    };
    const slot = renderSlot(
      app.fileOpeners[0]!,
      { path: "/Users/me/.claude/plans/plan.md", source, Original: () => null },
      {
        openFileExternally,
        rpc: {
          openFile: () => ({
            file: { content: "# Plan", sha256: "sha" },
            preview,
            previewPath: "plan.md",
            hostId: "host_mac",
          }),
        },
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Open file externally" }));
    expect(openFileExternally).toHaveBeenCalledWith({
      target: { kind: "host", hostId: "host_mac", path: "/Users/me/.claude/plans/plan.md" },
      location: null,
    });
  });

  it("reloads an opened file when its host reports a new hash, without rereading on a timer", async () => {
    let disk = { content: "# Plan\n\nFirst draft", sha256: "sha-1" };
    const source = {
      kind: "host" as const,
      threadId: "thr_1",
      environmentId: null,
      projectId: "project_1",
      experimental_hostId: "host_remote",
    };
    const slot = renderSlot(
      app.fileOpeners[0]!,
      { path: "/Users/shared/notes/plan.md", source, Original: () => null },
      {
        rpc: {
          openFile: () => ({ file: disk, preview, previewPath: "notes/plan.md" }),
          watchOpenedFile: () => ({ watchId: "w1", sha256: disk.sha256, renewWithinMs: 60_000 }),
        },
      },
    );

    await slot.findByText("First draft");
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "watchOpenedFile",
        input: { source, path: "/Users/shared/notes/plan.md" },
      }),
    );
    const opens = () => slot.rpcCalls.filter((call) => call.method === "openFile").length;
    disk = { content: "# Plan\n\nAgent rewrite", sha256: "sha-2" };
    // The old 1.5 s poll would have reread by now; nothing asks until the host says so.
    await act(() => new Promise((resolve) => setTimeout(resolve, 1_700)));
    expect(opens()).toBe(1);
    // Another watch's change and an echo of the loaded hash change nothing.
    await slot.emitRealtime("opened-file-changed", { watchId: "w2", sha256: "sha-2" });
    await slot.emitRealtime("opened-file-changed", { watchId: "w1", sha256: "sha-1" });
    expect(opens()).toBe(1);

    await slot.emitRealtime("opened-file-changed", { watchId: "w1", sha256: "sha-2" });
    await slot.findByText("Agent rewrite");
    expect(opens()).toBe(2);
    expect(slot.rpcCalls.filter((call) => call.method === "watchOpenedFile")).toHaveLength(1);
  });

  it("skips an opened file's own save echo even when it arrives before the save answers", async () => {
    const source = {
      kind: "host" as const,
      threadId: "thr_1",
      environmentId: null,
      projectId: "project_1",
      experimental_hostId: "host_remote",
    };
    const saved = deferred<{ outcome: "written"; sha256: string }>();
    const slot = renderSlot(
      app.fileOpeners[0]!,
      { path: "/Users/shared/notes/plan.md", source, Original: () => null },
      {
        rpc: {
          openFile: () => ({
            file: { content: "# Plan\n\nFirst draft", sha256: "sha-1" },
            preview,
            previewPath: "notes/plan.md",
          }),
          watchOpenedFile: () => ({ watchId: "w1", sha256: "sha-1", renewWithinMs: 60_000 }),
          saveOpenedFile: () => saved.promise,
        },
      },
    );
    const body = await slot.findByText("First draft");
    await waitFor(() =>
      expect(slot.rpcCalls.some((call) => call.method === "watchOpenedFile")).toBe(true),
    );
    body.textContent = "Edited draft";
    fireEvent.input(body);
    await waitFor(
      () => expect(slot.rpcCalls.some((call) => call.method === "saveOpenedFile")).toBe(true),
      { timeout: 2_000 },
    );
    // The host reports the write before the save's answer lands.
    await slot.emitRealtime("opened-file-changed", { watchId: "w1", sha256: "sha-2" });
    await act(async () => {
      saved.resolve({ outcome: "written", sha256: "sha-2" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(slot.rpcCalls.filter((call) => call.method === "openFile")).toHaveLength(1);
  });

  it("keeps Docs sibling order where Pierre's default sort disagrees", async () => {
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              ["another.md", "another2.md", "zeta.md"].map((path) => ({
                path,
                title: path,
                preview: "",
                modifiedAtMs: 1,
              })),
              undefined,
              ["zeta.md"],
            ),
        },
      },
    );

    await findTreeItem(slot.container, "another2.md");
    expect(treeItemLabels(slot.container)).toEqual(["zeta.md", "another.md", "another2.md"]);
  });
});
