import type { ExperimentalTabRegistration } from "@get-bb/plugin-sdk";
// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import { afterEach, beforeEach, describe, expect, it, vi, onTestFinished } from "vitest";
import { loadPluginApp, renderSlot, type RenderSlotOptions } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
const docsRegistration = app.navPanels[0]!;
const navigationView = app.tabs.find(
  (
    tab,
  ): tab is Extract<
    ExperimentalTabRegistration,
    { context: { kind: "nav-panel" }; availability: "fixed" }
  > => tab.context.kind === "nav-panel" && tab.availability === "fixed" && tab.id === "navigation",
)!;
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

function documentResult(
  path: string,
  content: string,
  sha256 = "sha",
  proposal: unknown = null,
  vaultId = "personal",
) {
  return { vaultId, path, content, sha256, proposal, preview };
}

function saved(path: string, sha256 = "next-sha") {
  return { path, sha256 };
}

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
        readDocument: () => documentResult(path, "Original paragraph.", "original-sha"),
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
                hostId: null,
                rootPath: `/vaults/${vaultId}`,
              },
            };
          },
          readDocument: (rawInput: unknown) => {
            const input = rawInput as { vaultId: string; path: string };
            return documentResult(
              input.path,
              `# ${input.vaultId === "work" ? "Work" : "Personal"}`,
              input.vaultId,
              null,
              input.vaultId,
            );
          },
        },
      },
    );
    await slot.findByText("Personal");

    slot.rerender(<PanelContent subPath="work/two.md" />);
    await slot.findByText("Work");
    expect(slot.rpcCalls).toContainEqual({
      method: "readDocument",
      input: { vaultId: "work", path: "two.md" },
    });

    slot.rerender(<PanelContent subPath="personal/one.md" />);
    await slot.findByText("Personal");
    expect(slot.rpcCalls).toContainEqual({
      method: "readDocument",
      input: { vaultId: "personal", path: "one.md" },
    });
  });

  it("shares one notebook request across page and navigation and refreshes it once per vault change", async () => {
    type PendingNotebook = {
      vaultId: string;
      resolve: (value: ReturnType<typeof listNotesResult>) => void;
    };
    const pending: PendingNotebook[] = [];
    const notebook = (vaultId: "personal" | "work") =>
      listNotesResultForVault(
        vaultId,
        `${vaultId}.md`,
        vaultId === "work" ? "Work note" : "Personal note",
      );
    const Surfaces = (props: { subPath: string }) => (
      <>
        <docsRegistration.component {...props} />
        <navigationView.component {...props} />
      </>
    );
    const slot = renderSlot(
      { ...navigationRegistration, component: Surfaces },
      { subPath: "personal/personal.md" },
      {
        rpc: {
          listNotes: (rawInput: unknown) => {
            const input = rawInput as { vaultId?: string } | undefined;
            const vaultId = input?.vaultId ?? "personal";
            return new Promise<ReturnType<typeof listNotesResult>>((resolve) => {
              pending.push({ vaultId, resolve });
            });
          },
          readDocument: (rawInput: unknown) => {
            const input = rawInput as { vaultId: string; path: string };
            return documentResult(
              input.path,
              `# ${input.vaultId === "work" ? "Work document" : "Personal document"}`,
              input.vaultId,
              null,
              input.vaultId,
            );
          },
          createNote: () => ({ path: "created.md" }),
        },
      },
    );
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending.map((request) => request.vaultId)).toEqual(["personal"]);
    for (const request of pending.splice(0)) request.resolve(notebook("personal"));
    await slot.findByText("Personal document");
    await findTreeItem(slot.container, "personal.md");

    await slot.experimental_invalidateRpc(["tree:work"]);
    expect(pending).toHaveLength(0);
    const personalRefresh = slot.experimental_invalidateRpc(["tree:personal"]);
    await waitFor(() => expect(pending).toHaveLength(1));
    for (const request of pending.splice(0)) request.resolve(notebook("personal"));
    await personalRefresh;

    slot.rerender(<Surfaces subPath="work/work.md" />);
    await slot.findByText("Work document");
    await waitFor(() => expect(pending).toHaveLength(1));
    const workRequests = pending.splice(0);
    expect(workRequests.map((request) => request.vaultId)).toEqual(["work"]);
    for (const request of workRequests) request.resolve(notebook("work"));
    await findTreeItem(slot.container, "work.md");

    expect(slot.queryByText("Personal document")).toBeNull();
    expect(slot.queryByText("Personal note")).toBeNull();

    fireEvent.click(slot.getAllByRole("button", { name: "New note" }).at(-1)!);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "createNote",
        input: { vaultId: "work", parent: "", name: "Untitled" },
      }),
    );
  });

  it("keeps the editor and typing when a save renames the document after its heading", async () => {
    const PanelContent = docsRegistration.component;
    const saveDocument = vi.fn((rawInput: unknown) => {
      const input = rawInput as { path: string; content: string };
      return saved(input.content.startsWith("# Renamed") ? "renamed.md" : input.path);
    });
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/draft.md" },
      {
        rpc: {
          listNotes: () => listNotesResultForVault("personal", "draft.md", "Draft"),
          readDocument: (rawInput: unknown) => {
            const input = rawInput as { path: string };
            return documentResult(input.path, "# Draft\n\nBody", "sha");
          },
          saveDocument,
        },
      },
    );
    const heading = await slot.findByText("Draft");
    const editor = slot.getByRole("textbox", { name: "Document content" });
    heading.textContent = "Renamed";
    fireEvent.input(heading);
    await waitFor(
      () =>
        expect(slot.navigateCalls).toContainEqual({
          method: "toPluginPanel",
          path: "docs",
          options: { subPath: "personal/renamed.md", replace: true },
        }),
      { timeout: 2_000 },
    );
    expect(saveDocument.mock.calls[0]?.[0]).toMatchObject({
      path: "draft.md",
      renameToTitle: true,
    });
    slot.rerender(<PanelContent subPath="personal/renamed.md" />);
    await act(async () => undefined);
    expect(slot.getByRole("textbox", { name: "Document content" })).toBe(editor);
    expect(editor.textContent).toContain("Renamed");
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("keeps the open document on screen until the next one loads", async () => {
    const PanelContent = docsRegistration.component;
    const next = deferred<ReturnType<typeof documentResult>>();
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/switch-first.md" },
      {
        rpc: {
          listNotes: () => listNotesResultForVault("personal", "switch-first.md", "First"),
          readDocument: (rawInput: unknown) => {
            const input = rawInput as { path: string };
            return input.path === "switch-first.md"
              ? documentResult(input.path, "# First\n\nFirst body", "sha-1")
              : next.promise;
          },
        },
      },
    );
    await slot.findByText("First body");
    slot.rerender(<PanelContent subPath="personal/switch-second.md" />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(slot.getByText("First body")).toBeTruthy();
    expect(slot.queryByRole("status", { name: "Loading document" })).toBeNull();
    next.resolve(documentResult("switch-second.md", "# Second\n\nSecond body", "sha-2"));
    await slot.findByText("Second body");
    await act(async () => undefined);
    expect(slot.queryByText("First body")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(slot.getByRole("textbox", { name: "Document content" })),
    );
  });

  it("focuses the end of the document when the space below it is clicked", async () => {
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/whitespace.md" },
      {
        rpc: {
          listNotes: () => listNotesResultForVault("personal", "whitespace.md", "Space"),
          readDocument: (rawInput: unknown) => {
            const input = rawInput as { path: string };
            return documentResult(input.path, "# Space\n\nLast line", "sha");
          },
        },
      },
    );
    const editor = await slot.findByRole("textbox", {
      name: "Document content",
    });
    await slot.findByText("Last line");
    editor.blur();
    fireEvent.mouseDown(editor.parentElement!, { button: 0, clientY: 10 });
    await waitFor(() => expect(document.activeElement).toBe(editor));
    expect(getSelection()?.anchorNode?.textContent).toBe("Last line");
  });

  it("ignores an obsolete vault refresh and rename after a deferred save", async () => {
    const pendingSave = deferred<{ path: string; sha256: string }>();
    const pendingWorkNotebook = deferred<ReturnType<typeof listNotesResultForVault>>();
    let workNotebookRequested = false;
    const PanelContent = docsRegistration.component;
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/deferred.md" },
      {
        rpc: {
          listNotes: (rawInput: unknown) => {
            const input = rawInput as { vaultId?: string } | undefined;
            if (input?.vaultId === "work") {
              workNotebookRequested = true;
              return pendingWorkNotebook.promise;
            }
            return listNotesResultForVault("personal", "deferred.md", "Personal note");
          },
          readDocument: (rawInput: unknown) => {
            const input = rawInput as { vaultId: string; path: string };
            return documentResult(
              input.path,
              input.vaultId === "work"
                ? "# Work document\n\nWork body"
                : "# Personal document\n\nPersonal body",
              input.vaultId,
              null,
              input.vaultId,
            );
          },
          saveDocument: () => pendingSave.promise,
        },
      },
    );
    const body = await slot.findByText("Personal body");
    body.textContent = "Edited personal body";
    fireEvent.input(body);
    await waitFor(
      () => expect(slot.rpcCalls.some((call) => call.method === "saveDocument")).toBe(true),
      { timeout: 2_000 },
    );

    slot.rerender(<PanelContent subPath="work/deferred-work.md" />);
    await waitFor(() => expect(workNotebookRequested).toBe(true));
    await act(async () => {
      pendingSave.resolve({
        path: "personal-renamed.md",
        sha256: "saved-personal",
      });
    });
    pendingWorkNotebook.resolve(listNotesResultForVault("work", "deferred-work.md", "Work note"));

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
      vaults: available.vaults.map((vault) => Object.assign({}, vault, { hostId: "host_remote" })),
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

  it("renders and autosaves editable Markdown tables", async () => {
    const saveDocument = vi.fn((rawInput: unknown) => saved((rawInput as { path: string }).path));
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
          readDocument: (rawInput: unknown) =>
            documentResult(
              (rawInput as { path: string }).path,
              "# Status\n\n| Project | State |\n| --- | --- |\n| Docs | Ready |",
              "sha",
            ),
          saveDocument,
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

    const firstBodyCell = table?.querySelector("td p");
    expect(firstBodyCell).toBeTruthy();
    firstBodyCell!.textContent = "Plans";
    fireEvent.input(firstBodyCell!);
    await waitFor(() => expect(saveDocument).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(saveDocument.mock.calls.at(-1)?.[0]).toMatchObject({
      content: expect.stringContaining("| Plans | Ready |"),
    });
  });

  it("preserves video HTML when autosaving an unrelated prose edit", async () => {
    const video = `<div style="margin-block: 1rem;">
  <video src="/rewinding-agents/partial-payments.mp4" autoplay loop muted playsinline preload="metadata" poster="/rewinding-agents/partial-payments-poster.jpg" width="1920" height="1080" aria-label="Two agents implement partial payments; rewinding Agent A preserves Agent B’s payment" style="width: 100%; height: auto; display: block; border-radius: 0.5rem;"></video>
</div>`;
    const saveDocument = vi.fn((rawInput: unknown) => saved((rawInput as { path: string }).path));
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/video-page.md" },
      {
        rpc: {
          listNotes: () => listNotesResult([]),
          readDocument: (rawInput: unknown) =>
            documentResult(
              (rawInput as { path: string }).path,
              `# Wiki page\n\n${video}\n\nOriginal body.`,
              "sha",
            ),
          saveDocument,
        },
      },
    );
    const body = await slot.findByText("Original body.");
    expect(slot.container.querySelector(".tiptap video")).toBeNull();
    body.textContent = "Edited body.";
    fireEvent.input(body);
    await waitFor(() => expect(saveDocument).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(saveDocument.mock.calls.at(-1)?.[0]).toMatchObject({
      content: expect.stringContaining(video),
    });
    expect(saveDocument.mock.calls.at(-1)?.[0]).toMatchObject({
      content: expect.stringContaining("Edited body."),
    });
  });

  it("hides and preserves YAML frontmatter when editing a document", async () => {
    const frontmatter = ["---\r\n", "title: Wiki page\r\n", "type: knowledge\r\n", "---\r\n"].join(
      "",
    );
    const saveDocument = vi.fn((rawInput: unknown) => saved((rawInput as { path: string }).path));
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
          readDocument: (rawInput: unknown) =>
            documentResult(
              (rawInput as { path: string }).path,
              `${frontmatter}\r\n# Wiki page\r\n\r\nOriginal body.`,
              "sha",
            ),
          saveDocument,
        },
      },
    );

    const body = await slot.findByText("Original body.");
    const editor = slot.container.querySelector(".tiptap");
    expect(editor?.textContent).not.toContain("type: knowledge");
    expect(editor?.querySelector("hr")).toBeNull();

    body.textContent = "Edited body.";
    fireEvent.input(body);
    await waitFor(() => expect(saveDocument).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(saveDocument.mock.calls.at(-1)?.[0]).toMatchObject({
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
          readDocument: () => documentResult("break.md", content),
          saveDocument: (rawInput: unknown) => saved((rawInput as { path: string }).path),
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
          readDocument: () =>
            documentResult(
              "projects/article.md",
              '# Article\n\n![Sketch](./_attachments/sketch.png)\n\n::html{src="./report.html" height="240"}',
              "sha-1",
            ),
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
      tab: {
        id: "document",
        context: { kind: "thread" },
        availability: "action",
      },
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

  it("shows cached document content immediately when returning to a thread", async () => {
    const file = documentResult("cached-draft.md", "Keep this draft visible.", "saved-sha");
    const readDocument = vi.fn<() => Promise<typeof file>>().mockResolvedValue(file);
    const render = () =>
      renderDocument("cached-draft.md", "Cached draft", {
        rpc: {
          readDocument,
        },
      });
    const first = render();
    await first.findByText(file.content);
    await act(async () => {
      first.unmount();
    });
    let finish!: (result: typeof file) => void;
    readDocument.mockReturnValueOnce(
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
          readDocument: (rawInput: unknown) =>
            documentResult((rawInput as { path: string }).path, "A long document.", "tall-sha"),
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
        tab: {
          id: "document",
          context: { kind: "thread" },
          availability: "action",
        },
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
      tab: {
        id: "document",
        context: { kind: "thread" },
        availability: "action",
      },
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
        readDocument: (rawInput: unknown) =>
          documentResult((rawInput as { path: string }).path, "Email body.", "original-sha"),
      },
    });
    await slot.findByRole("textbox", { name: "Document content" });
    fireEvent.click(slot.getByRole("button", { name: "Ask for changes" }));
    await waitFor(() =>
      expect(slot.inspection.composer.draft.mentions).toMatchObject([
        {
          kind: "plugin",
          provider: "note",
          id: "personal:ask-inline.md",
          label: "Launch email",
        },
      ]),
    );
    expect(slot.inspection.composer.text).toBe("Keep this instruction.\n\nUpdate @Launch email ");
    expect(slot.inspection.composer.focusCount).toBeGreaterThan(0);
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
      let current: Record<string, unknown> = pending;
      const resolved = async (next: Record<string, unknown>) => {
        await resolution.promise;
        current = next;
        return next;
      };
      const resolveProposal = vi
        .fn()
        .mockImplementationOnce(() =>
          resolved({
            ...pending,
            version: pending.version + 1,
            status: action === "reject" ? "rejected" : "pending",
          }),
        )
        .mockImplementationOnce(() =>
          resolved({
            ...pending,
            version: pending.version + 2,
            status: "pending",
          }),
        );
      const slot = renderDocument(pending.path, "Proposal", {
        rpc: {
          readDocument: () =>
            documentResult(pending.path, "Original paragraph.", "original-sha", current),
          resolveProposal,
        },
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
        await slot.experimental_invalidateRpc([`doc:personal:${pending.path}`]);
        await waitFor(() => expect(slot.queryByRole("status")).toBeNull());
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
    const readDocument = vi.fn(() =>
      documentResult(pending.path, pending.baseContent, "original-sha", pending),
    );
    const slot = renderDocument(pending.path, "Scoped example", {
      rpc: { readDocument },
    });
    await slot.findByRole("textbox", { name: "Document content" });
    const baselines = parse.mock.calls
      .map(([root]) => root)
      .filter((root) => root.textContent?.includes("Original <strong>formatted baseline</strong>"));
    expect(baselines.length).toBeGreaterThan(0);
    for (const root of baselines) expect(root.ownerDocument?.defaultView).toBeNull();
    expect(slot.container.querySelector("strong")?.textContent).toBe("formatted baseline");
    parse.mockRestore();
    readDocument.mockClear();
    await slot.experimental_invalidateRpc(["vault:other"]);
    await slot.experimental_invalidateRpc(["doc:personal:other.md"]);
    await slot.experimental_invalidateRpc(["tree:personal"]);
    expect(readDocument).not.toHaveBeenCalled();
    await slot.experimental_invalidateRpc([`doc:personal:${pending.path}`]);
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(1));
    await slot.experimental_invalidateRpc(["vault:personal"]);
    await waitFor(() => expect(readDocument).toHaveBeenCalledTimes(2));
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
          readDocument: (rawInput: unknown) =>
            documentResult(
              (rawInput as { path: string }).path,
              "# Release plan\n\nShip it.",
              "sha",
            ),
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
    fireEvent.click(slot.getByRole("button", { name: "Open in Docs" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "personal/plans/panel-release.md" },
    });
  });

  it("preserves the file opener host through autosave and resolves a conflict in place", async () => {
    const source = {
      kind: "host",
      threadId: "thr_1",
      environmentId: null,
      projectId: "project_1",
      experimental_hostId: "host_remote",
    } as const;
    const file = { content: "# Remote plan", sha256: "sha" };
    const saveOpenedFile = vi.fn((rawInput: unknown) => {
      const input = rawInput as { content: string; expectedSha256: string };
      if (input.expectedSha256 !== file.sha256)
        return { outcome: "conflict", currentSha256: file.sha256 };
      file.content = input.content;
      file.sha256 = `sha-${saveOpenedFile.mock.calls.length}`;
      return { outcome: "written", sha256: file.sha256 };
    });
    const slot = renderSlot(
      app.fileOpeners[0]!,
      { path: "/Users/shared/notes/plan.mdx", source, Original: () => null },
      {
        rpc: {
          openFile: () => ({
            file: { ...file },
            preview,
            previewPath: "notes/plan.mdx",
          }),
          saveOpenedFile,
        },
      },
    );

    const body = await slot.findByText("Remote plan");
    expect(slot.rpcCalls).toContainEqual({
      method: "openFile",
      input: { source, path: "/Users/shared/notes/plan.mdx" },
    });
    body.textContent = "Updated remote plan";
    fireEvent.input(body);
    await waitFor(() => expect(file.content).toBe("# Updated remote plan"), {
      timeout: 2_000,
    });
    expect(saveOpenedFile.mock.calls[0]?.[0]).toEqual({
      source,
      path: "/Users/shared/notes/plan.mdx",
      content: "# Updated remote plan",
      expectedSha256: "sha",
    });

    file.content = "# Plan rewritten elsewhere";
    file.sha256 = "remote-sha";
    const heading = slot.getByText("Updated remote plan");
    heading.textContent = "My local plan";
    fireEvent.input(heading);
    await slot.findByRole("button", { name: "Keep mine" }, { timeout: 2_000 });
    expect(file.content).toBe("# Plan rewritten elsewhere");
    expect(slot.getByText("My local plan")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Keep mine" }));
    await waitFor(() => expect(file.content).toBe("# My local plan"));
    expect(saveOpenedFile.mock.calls.at(-1)?.[0]).toMatchObject({
      expectedSha256: "remote-sha",
    });
    expect(slot.queryByRole("alert")).toBeNull();
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
      expect(iframe?.classList.contains("min-h-0")).toBe(true);
    });
    expect(slot.queryByRole("button", { name: "View source" })).toBeNull();
  });

  it("searches the latest note previews when search opens", async () => {
    let preview = "Old body";
    const slot = renderSlot(
      navigationRegistration,
      { subPath: "personal" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([{ path: "draft.md", title: "Draft", preview, modifiedAtMs: 1 }]),
        },
      },
    );
    await findTreeItem(slot.container, "draft.md");
    preview = "Freshly typed words";
    fireEvent.click(slot.getByLabelText("Search notes"));
    fireEvent.change(slot.getByPlaceholderText("Search this vault"), {
      target: { value: "freshly" },
    });
    await findTreeItem(slot.container, "draft.md");
    expect(slot.rpcCalls.filter((call) => call.method === "listNotes")).toHaveLength(2);
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
});

function fakeVault(initial: Record<string, string>) {
  let revision = 0;
  const files = new Map(
    Object.entries(initial).map(([path, content]) => [
      path,
      { content, sha256: `sha-${(revision += 1)}` },
    ]),
  );
  const current = (path: string) => {
    const file = files.get(path);
    if (!file) throw new Error(`Path does not exist: ${path}`);
    return file;
  };
  const write = (path: string, content: string) => {
    const file = { content, sha256: `sha-${(revision += 1)}` };
    files.set(path, file);
    return file;
  };
  const rpc = {
    listNotes: () =>
      listNotesResult(
        [...files.keys()].map((path) => ({
          path,
          title: path,
          preview: "",
          modifiedAtMs: 1,
        })),
      ),
    readNote: (rawInput: unknown) => {
      const { path } = rawInput as { path: string };
      const file = current(path);
      return { path, ...file, contentEncoding: "utf8", sizeBytes: 1 };
    },
    readProposal: () => null,
    preparePreview: () => preview,
    renameToTitle: (rawInput: unknown) => ({
      path: (rawInput as { path: string }).path,
    }),
    saveNote: (rawInput: unknown) => {
      const input = rawInput as {
        path: string;
        content: string;
        expectedSha256?: string;
      };
      const existing = files.get(input.path);
      if (input.expectedSha256 !== undefined && existing?.sha256 !== input.expectedSha256)
        return { outcome: "conflict", currentSha256: existing?.sha256 ?? null };
      return {
        outcome: "written",
        sha256: write(input.path, input.content).sha256,
        sizeBytes: 1,
      };
    },
    readDocument: (rawInput: unknown) => {
      const { path } = rawInput as { path: string };
      const file = current(path);
      return documentResult(path, file.content, file.sha256);
    },
    saveDocument: (rawInput: unknown) => {
      const input = rawInput as {
        path: string;
        content: string;
        expectedSha256: string;
      };
      if (files.get(input.path)?.sha256 !== input.expectedSha256)
        throw new Error("This document changed elsewhere.");
      return saved(input.path, write(input.path, input.content).sha256);
    },
  };
  return {
    rpc,
    content: (path: string) => files.get(path)?.content,
    async remoteWrite(slot: ReturnType<typeof renderSlot>, path: string, content: string | null) {
      if (content === null) files.delete(path);
      else write(path, content);
      await slot.emitRealtime("vault-changed", { vaultId: "personal", path });
      await slot.experimental_invalidateRpc([`doc:personal:${path}`]);
    },
  };
}

function paragraph(slot: ReturnType<typeof renderSlot>, text: string) {
  const match = [...slot.container.querySelectorAll(".tiptap p")].find((element) =>
    element.textContent?.startsWith(text),
  );
  if (!match) throw new Error(`No paragraph starting with ${text}`);
  return match as HTMLElement;
}

describe("Docs live documents", () => {
  it("offers Keep mine and Use theirs instead of getting stuck when another writer saves during typing", async () => {
    const vault = fakeVault({
      "live-card.md": "First paragraph.\n\nSecond paragraph.\n",
    });
    const slot = renderDocument("live-card.md", "Live card", {
      rpc: vault.rpc,
    });
    await slot.findByText("Second paragraph.");
    const first = paragraph(slot, "First");
    first.textContent = "First paragraph, typed.";
    fireEvent.input(first);
    await vault.remoteWrite(
      slot,
      "live-card.md",
      "First paragraph.\n\nSecond paragraph, by the agent.\n",
    );
    fireEvent.click(await slot.findByRole("button", { name: "Keep mine" }));
    await waitFor(
      () =>
        expect(vault.content("live-card.md")).toBe(
          "First paragraph, typed.\n\nSecond paragraph.\n",
        ),
      { timeout: 2_000 },
    );
    expect(slot.queryByRole("alert")).toBeNull();
    expect(slot.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("does not undo another writer's change", async () => {
    const vault = fakeVault({ "undo-card.md": "Original body.\n" });
    const slot = renderDocument("undo-card.md", "Undo card", {
      rpc: vault.rpc,
    });
    const editor = await slot.findByRole("textbox", {
      name: "Document content",
    });
    await slot.findByText("Original body.");
    await vault.remoteWrite(slot, "undo-card.md", "Body written by the agent.\n");
    await slot.findByText("Body written by the agent.");
    fireEvent.focus(editor);
    fireEvent.keyDown(editor, { key: "z", code: "KeyZ", ctrlKey: true });
    fireEvent.keyDown(editor, { key: "z", code: "KeyZ", metaKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(editor.textContent).toContain("Body written by the agent.");
    expect(vault.content("undo-card.md")).toBe("Body written by the agent.\n");
  });

  it("shows another writer's save in the open Docs page", async () => {
    const vault = fakeVault({ "live-page.md": "# Live page\n\nOld body.\n" });
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/live-page.md" },
      { rpc: vault.rpc },
    );
    await slot.findByText("Old body.");
    await vault.remoteWrite(slot, "live-page.md", "# Live page\n\nNew body from the CLI.\n");
    await slot.findByText("New body from the CLI.");
  });

  it("does not recreate a document another writer moved away", async () => {
    const vault = fakeVault({ "moved-page.md": "# Moved\n\nBody.\n" });
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/moved-page.md" },
      { rpc: vault.rpc },
    );
    await slot.findByText("Body.");
    await vault.remoteWrite(slot, "moved-page.md", null);
    await slot.findByText("This document was moved or deleted elsewhere.");
    const body = paragraph(slot, "Body.");
    body.textContent = "Body, typed after the move.";
    fireEvent.input(body);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    });
    expect(vault.content("moved-page.md")).toBeUndefined();
    expect(slot.getByRole("button", { name: "Save a copy" })).toBeTruthy();
  });

  it("keeps the same editor when the preview link is renewed", async () => {
    let baseUrl = "/api/v1/file-previews/first";
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/lease-page.md" },
      {
        rpc: {
          listNotes: () => listNotesResult([]),
          readNote: () => ({
            content: "# Lease\n\n![Pixel](./pixel.png)\n\nBody.\n",
            sha256: "sha",
          }),
          preparePreview: () => ({ baseUrl, expiresAtMs: Date.now() + 60_000 }),
          readDocument: () => ({
            ...documentResult("lease-page.md", "# Lease\n\n![Pixel](./pixel.png)\n\nBody.\n"),
            preview: { baseUrl, expiresAtMs: Date.now() + 60_000 },
          }),
        },
      },
    );
    await slot.findByText("Body.");
    const editor = slot.getByRole("textbox", { name: "Document content" });
    expect(slot.container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/v1/file-previews/first/pixel.png",
    );
    baseUrl = "/api/v1/file-previews/renewed";
    await slot.emitRealtime("vault-changed", {
      vaultId: "personal",
      path: "lease-page.md",
    });
    await slot.experimental_invalidateRpc(["doc:personal:lease-page.md"]);
    await waitFor(() =>
      expect(slot.container.querySelector("img")?.getAttribute("src")).toBe(
        "/api/v1/file-previews/renewed/pixel.png",
      ),
    );
    expect(slot.getByRole("textbox", { name: "Document content" })).toBe(editor);
  });
});

describe("Docs fork behavior", () => {
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
        icon: "FileText",
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
    await slot.experimental_invalidateRpc(["tree:obsidian"]);
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
          readDocument: (raw: unknown) => ({
            ...documentResult((raw as { path: string }).path, "", "sha"),
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
  it("copies the document through the host clipboard", async () => {
    const slot = renderDocument("copy-inline.md", "Launch email", {
      rpc: {
        readDocument: (raw: unknown) => ({
          ...documentResult((raw as { path: string }).path, "", "sha"),
          content: "Email body.",
          sha256: "original-sha",
        }),
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
          readDocument: (raw: unknown) => ({
            ...documentResult((raw as { path: string }).path, "", "sha"),
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
});

describe("Docs markdown extension routing", () => {
  it("opens and autosaves a .markdown vault document through the registered page", async () => {
    const saveDocument = vi.fn(async () => ({ path: "notes.markdown", sha256: "updated" }));
    const slot = renderSlot(
      docsRegistration,
      { subPath: "personal/notes.markdown" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              { path: "notes.markdown", title: "Notes", preview: "", modifiedAtMs: 1 },
            ]),
          readDocument: () =>
            documentResult("notes.markdown", "Markdown extension body", "initial"),
          saveDocument,
        },
      },
    );
    const paragraph = await slot.findByText("Markdown extension body");
    paragraph.textContent = "Edited Markdown extension body";
    fireEvent.input(paragraph);
    await waitFor(
      () =>
        expect(saveDocument).toHaveBeenCalledWith(
          expect.objectContaining({
            path: "notes.markdown",
            content: expect.stringContaining("Edited Markdown extension body"),
          }),
        ),
      { timeout: 2000 },
    );
  });
});

describe("Docs standalone host-file preview", () => {
  it("keeps relative images on the same preview URL after autosaving an absolute host file", async () => {
    const saveOpenedFile = vi.fn(async () => ({
      outcome: "written",
      sha256: "saved",
      sizeBytes: 4,
    }));
    const slot = renderSlot(
      app.fileOpeners[0]!,
      {
        path: "/Users/shared/notes/plan.md",
        Original: () => null,
        source: {
          kind: "host",
          threadId: null,
          environmentId: null,
          projectId: null,
          experimental_hostId: "host_mac",
        },
      },
      {
        rpc: {
          openFile: () => ({
            file: { content: "![Image](./image.png)\n\nOriginal paragraph", sha256: "initial" },
            preview: { baseUrl: "/preview", expiresAtMs: Date.now() + 600_000 },
            previewPath: "plan.md",
            hostId: "host_mac",
          }),
          saveOpenedFile,
        },
      },
    );
    const image = await slot.findByRole("img", { name: "Image" });
    expect(image.getAttribute("src")).toBe("/preview/image.png");
    const paragraph = await slot.findByText("Original paragraph");
    paragraph.textContent = "Edited paragraph";
    fireEvent.input(paragraph);
    await waitFor(() => expect(saveOpenedFile).toHaveBeenCalled(), { timeout: 2000 });
    expect(slot.getByRole("img", { name: "Image" }).getAttribute("src")).toBe("/preview/image.png");
  });
});
