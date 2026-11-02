import { expect, mock, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
for (const name of ["Event", "CustomEvent", "FocusEvent", "KeyboardEvent", "PointerEvent"] as const)
  if (name in window)
    Object.defineProperty(globalThis, name, { configurable: true, value: window[name as "Event"] });
const { act, fireEvent, waitFor } = await import("@testing-library/react");
const { createElement, Fragment } = await import("react");
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { queryClient } = await import("../src/app/query.ts");

const thread = {
  id: "thr_1",
  projectId: "proj_1",
  environment: {
    id: "env_1",
    name: "bb-plugins",
    branchName: "scott/details",
    path: "/Users/scott/git/bb-plugins",
    isWorktree: false,
    providerId: "local",
    workspaceDisplayKind: null,
  },
  host: { id: "host_mac", name: "Scott's MacBook Pro" },
};

type Scripts = Array<{ id: string; name: string; command: string }>;

/**
 * bb's card around the workspace rows, plus the plugin's app overlays. `rows:
 * false` models bb unmounting the rows, as its narrow-pane popover does on close.
 */
async function renderWorkspace(scripts: Scripts | Error = []) {
  queryClient.clear();
  const app = await loadPluginApp(() => import("../src/app/app.tsx"));
  const registration = app.threadContextCardRows.find((row) => row.id === "workspace");
  const overlay = app.appOverlays.find((entry) => entry.id === "script-editor");
  if (!registration || !overlay) throw new Error("Missing workspace rows or script editor");
  const create = mock(async (_args: unknown) => ({ id: "term_1" }));
  const gitRead = mock(async () => {
    throw new Error("Workspace rows must not query Git");
  });
  const save = mock(async (_input: unknown) => ({ scripts: [] as Scripts }));
  const props = {
    threadId: thread.id,
    projectId: thread.projectId,
    // bb hands rows only the environment id.
    environment: { id: thread.environment.id },
  };
  const Host = ({ rows = true }: { rows?: boolean }) =>
    createElement(
      Fragment,
      null,
      rows ? createElement(registration.component, props) : null,
      createElement(overlay.component as never),
    );
  const slot = renderSlot(
    { id: "host", component: Host } as never,
    {},
    {
      pluginId: "kitchen-sink",
      sidebarThreads: {
        status: "ready",
        threads: [thread] as never,
        projects: [{ id: "proj_1", name: "bb-plugins" }] as never,
      },
      sdk: { plugins: { callRpc: gitRead }, terminals: { create: create as never } },
      rpc: {
        projectScripts: () => {
          if (scripts instanceof Error) throw scripts;
          return { scripts };
        },
        saveProjectScript: save,
      } as never,
    },
  );
  const showRows = (rows: boolean) => slot.rerender(createElement(Host, { rows }));
  return { slot, create, gitRead, save, showRows };
}

/**
 * Open a Radix menu the way a pointer does. jsdom has no PointerEvent to carry
 * `button`, and keyboard navigation hangs Radix menus there.
 */
function openMenu(trigger: HTMLElement) {
  act(() => {
    trigger.dispatchEvent(
      new window.MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
}

test("workspace rows retain machine and scripts without Git reads or actions", async () => {
  const { slot, gitRead } = await renderWorkspace();
  expect(slot.getByText("Scott's MacBook Pro")).toBeTruthy();
  await waitFor(() => expect(slot.getByText("Add project script")).toBeTruthy());
  expect(slot.queryByText("scott/details")).toBeNull();
  expect(slot.queryByText("Push & create PR")).toBeNull();
  expect(gitRead).not.toHaveBeenCalled();
  slot.unmount();
});

test("a saved script still runs in the owning thread's terminal", async () => {
  const { slot, create } = await renderWorkspace([
    { id: "s1", name: "Dev server", command: "bun run dev" },
  ]);
  fireEvent.click(await slot.findByText("Run Dev server"));
  await waitFor(() => expect(create).toHaveBeenCalled());
  expect(create.mock.calls[0]?.[0]).toMatchObject({
    scope: { kind: "thread", threadId: "thr_1" },
    start: { mode: "command", command: "bun run dev" },
  });
  slot.unmount();
});

test("failed script reads offer retry without an empty-list edit action", async () => {
  queryClient.setDefaultOptions({ queries: { retry: false } });
  const { slot } = await renderWorkspace(new Error("host unavailable"));
  await waitFor(() => expect(slot.getByText("Scripts unavailable")).toBeTruthy());
  expect(slot.queryByText("Add project script")).toBeNull();
  slot.unmount();
});

test("the script editor and its draft outlive the rows that opened it", async () => {
  const { slot, showRows, save } = await renderWorkspace();
  fireEvent.click(await slot.findByText("Add project script"));
  const name = await slot.findByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Dev server" } });
  fireEvent.change(slot.getByRole("textbox", { name: "Command" }), {
    target: { value: "bun run dev" },
  });
  // bb's popover closes on a row click, unmounting the rows; a breakpoint change remounts them.
  showRows(false);
  expect(slot.getByRole("dialog")).toBeTruthy();
  showRows(true);
  expect((slot.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe(
    "Dev server",
  );
  fireEvent.click(slot.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save.mock.calls[0]?.[0]).toMatchObject({
    projectId: "proj_1",
    edit: { kind: "upsert", script: { name: "Dev server", command: "bun run dev" } },
  });
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  slot.unmount();
});

test("the last script run stays preferred when the rows remount", async () => {
  const { slot, showRows } = await renderWorkspace([
    { id: "s1", name: "Dev server", command: "bun run dev" },
    { id: "s2", name: "Storybook", command: "bun run storybook" },
  ]);
  await slot.findByText("Run Dev server");
  openMenu(slot.getByRole("button", { name: "Project scripts" }));
  fireEvent.click(await slot.findByRole("menuitem", { name: /^Storybook/ }));
  await waitFor(() => expect(slot.getByText("Run Storybook")).toBeTruthy());
  showRows(false);
  showRows(true);
  expect(await slot.findByText("Run Storybook")).toBeTruthy();
  slot.unmount();
});

test("closing the editor returns focus to the scripts menu button", async () => {
  const { slot } = await renderWorkspace([
    { id: "s1", name: "Dev server", command: "bun run dev" },
  ]);
  await slot.findByText("Run Dev server");
  const trigger = slot.getByRole("button", { name: "Project scripts" });
  openMenu(trigger);
  fireEvent.click(await slot.findByRole("menuitem", { name: "Edit Dev server" }));
  fireEvent.click(await slot.findByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  slot.unmount();
});
