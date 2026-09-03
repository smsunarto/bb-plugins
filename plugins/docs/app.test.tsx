// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
const docsRegistration = app.navPanels[0];
if (!docsRegistration) throw new Error("Docs navigation panel was not registered");
const navigationView = docsRegistration.fixedTabs?.[0];
if (!navigationView) throw new Error("Docs navigation tab was not registered");
const navigationRegistration = {
  ...docsRegistration,
  component: navigationView.component,
};

beforeEach(() => {
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
  Reflect.deleteProperty(document, "elementFromPoint");
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
        hostId: null,
        rootPath: "/Users/me/Notes",
      },
    ],
    vault: {
      id: "personal",
      name: "Personal",
      hostId: null,
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
        hostId: null,
        rootPath: "/vaults/personal",
      },
      {
        id: "work",
        name: "Work",
        hostId: null,
        rootPath: "/vaults/work",
      },
    ],
    vault: {
      id: vaultId,
      name: vaultId === "work" ? "Work" : "Personal",
      hostId: null,
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

function makeDataTransfer() {
  return {
    effectAllowed: "none",
    dropEffect: "none",
    types: ["text/plain"],
    setData: vi.fn(),
    setDragImage: vi.fn(),
    getData: vi.fn(() => ""),
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
  it("registers the Docs surfaces", () => {
    expect(app.navPanels[0]).toMatchObject({
      id: "docs",
      title: "Docs",
      path: "docs",
      fixedTabs: [
        {
          panelId: "docs",
          id: "navigation",
          title: "Navigation",
          icon: "ListView",
          layout: "flush",
        },
      ],
    });
    expect(app.navPanels[0]?.headerContent).toBeUndefined();
    expect(app.messageDirectives).toHaveLength(1);
    expect(app.messageDirectives[0]?.id).toBe("docs");
    expect(app.threadPanelActions[0]).toMatchObject({
      id: "document",
      title: "Document",
    });
    expect(app.fileOpeners[0]).toMatchObject({
      id: "docs",
      title: "Markdown",
      extensions: ["md", "mdx", "markdown"],
    });
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
          hostId: null,
          rootPath: "/vaults/personal",
        },
        {
          id: "work",
          name: "Work",
          hostId: null,
          rootPath: "/vaults/work",
        },
      ],
      vault: {
        id: vaultId,
        name: vaultId === "work" ? "Work" : "Personal",
        hostId: null,
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
    expect(styles?.textContent).toContain("height: 1.7em");
    expect(styles?.textContent).toContain("cursor: pointer; margin: 0");
    expect(styles?.textContent).toContain(
      'ul[data-type="taskList"] ul[data-type="taskList"] { margin-top: 0; }',
    );
    expect(styles?.textContent).toContain(
      'ul[data-type="taskList"] li { display: flex; align-items: flex-start; gap: 0.5em; margin-top: 0.5em;',
    );
  });

  it("applies the smsunarto Markdown reading theme", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/theme.md" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult([
              {
                path: "theme.md",
                title: "Theme",
                preview: "Styled document",
                modifiedAtMs: 1,
              },
            ]),
          readNote: () => ({
            content: "# Theme\n\n**Strong** and [linked](https://example.com).",
            sha256: "sha",
          }),
          preparePreview: () => preview,
          renameToTitle: () => ({ path: "theme.md" }),
        },
      },
    );

    await slot.findByText("Theme");
    const styles = document.head.querySelector("style[data-bb-simple-notes-styles]");
    expect(styles?.textContent).toContain(
      "Ported from smsunarto-theme/styles/cursor-markdown-preview.css",
    );
    expect(styles?.textContent).toContain("max-width: 700px");
    expect(styles?.textContent).toContain("color: #9ddd54");
    expect(styles?.textContent).toContain(".tiptap strong { color: #51dae9");
    expect(styles?.textContent).toContain(".tiptap a:hover { color: #75f0ff; }");
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
    expect(styles?.textContent).toContain("border-collapse: collapse");
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
              '# Article\n\n![Sketch](./_attachments/sketch.png)\n\n::html{src="./report.html" height="240"}',
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

  it("opens Docs directive cards in the thread panel or full editor", () => {
    const openThreadPanel = vi.fn(() => true);
    const slot = renderSlot(
      app.messageDirectives[0]!,
      {
        attributes: {
          vault: "personal",
          path: "plans/release.md",
          title: "Release plan",
        },
        source: '::docs{vault="personal" path="plans/release.md" title="Release plan"}',
        message: {
          id: "msg_1",
          threadId: "thr_1",
          turnId: "turn_1",
          projectId: null,
        },
        openWorkspaceFile: null,
      },
      { openThreadPanel },
    );

    fireEvent.click(slot.getByText("Release plan"));
    expect(slot.queryByText("personal · plans/release.md")).toBeNull();
    expect(openThreadPanel).toHaveBeenCalledWith({
      actionId: "document",
      title: "Release plan",
      params: {
        vaultId: "personal",
        path: "plans/release.md",
        title: "Release plan",
      },
    });

    fireEvent.click(slot.getByRole("button", { name: "Open in Docs" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "personal/plans/release.md" },
    });
  });

  it("renders a linked Markdown document in the Docs thread panel", async () => {
    const slot = renderSlot(
      app.threadPanelActions[0]!,
      {
        threadId: "thr_1",
        params: {
          vaultId: "personal",
          path: "plans/release.md",
          title: "Release plan",
        },
      },
      {
        rpc: {
          readNote: () => ({
            content: "# Release plan\n\nShip it.",
            sha256: "sha",
          }),
          preparePreview: () => preview,
        },
      },
    );

    await slot.findByText("Ship it.");
    expect(slot.getAllByText("Release plan")).toHaveLength(2);
    expect(slot.queryByText("plans/release.md")).toBeNull();
    expect(slot.getByRole("textbox").getAttribute("contenteditable")).toBe("true");
    expect(slot.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Mention in chat" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Open in Docs" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "toPluginPanel",
      path: "docs",
      options: { subPath: "personal/plans/release.md" },
    });
  });

  it("preserves an explicit host for file opener reads and autosaves", async () => {
    const slot = renderSlot(
      app.fileOpeners[0]!,
      {
        path: "/Users/shared/notes/plan.mdx",
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
            previewPath: "notes/plan.mdx",
          }),
          saveOpenedFile: () => ({
            outcome: "written",
            sha256: "updated-sha",
          }),
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
        path: "/Users/shared/notes/plan.mdx",
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
            path: "/Users/shared/notes/plan.mdx",
            content: "# Updated remote plan",
            expectedSha256: "sha",
          },
        });
      },
      { timeout: 2_000 },
    );
    expect(slot.queryByRole("button", { name: "Add to chat" })).toBeNull();
    expect(slot.queryByRole("button", { name: "Mention in chat" })).toBeNull();
  });

  it("opens a full HTML page through the same preview lease", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "personal/dashboards/metrics.html" },
      {
        rpc: {
          listNotes: () =>
            listNotesResult(
              [],
              [
                { kind: "directory", path: "dashboards" },
                { kind: "file", path: "dashboards/metrics.html" },
              ],
            ),
          preparePreview: () => preview,
        },
      },
    );

    await waitFor(() => {
      const iframe = slot.container.querySelector("iframe");
      expect(iframe?.getAttribute("src")).toBe(
        "/api/v1/file-previews/lease/dashboards/metrics.html",
      );
      expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts");
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
});
