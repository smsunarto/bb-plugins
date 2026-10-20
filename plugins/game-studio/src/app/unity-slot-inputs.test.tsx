import { afterEach, beforeEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
import type {
  PluginEnvironmentProviderInputsChange,
  PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import type { CheckoutSlot } from "../shared/unity-editor-contract.ts";

installDom();
const { installTestPluginRuntime, loadPluginApp, renderSlot } =
  await import("@get-bb/plugin-sdk/testing/app");
installTestPluginRuntime();
const { pluginQueryClient } = await import("@bb-kit/core/rpc/query");
const { cleanup, fireEvent, waitFor, within } = await import("@testing-library/react");
const { useState } = await import("react");
const { UnitySlotInputs } = await import("./unity-slot-inputs.tsx");

beforeEach(() => pluginQueryClient.clear());
afterEach(() => {
  cleanup();
  pluginQueryClient.clear();
});

function slot(id: string, overrides: Partial<CheckoutSlot> = {}): CheckoutSlot {
  const result: CheckoutSlot = {
    id: `inventory-${id}`,
    hostId: "host-1",
    workspacePath: `/work/${id}`,
    mainEditors: [],
    mppmEditors: [],
    claims: [],
    lifecycle: {
      id,
      hostId: "host-1",
      workspacePath: `/work/${id}`,
      projectId: "project-1",
      state: "available",
      ownerThreadId: null,
      reason: null,
      updatedAt: "2026-10-15T00:00:00Z",
    },
    ...overrides,
  };
  if (result.lifecycle === undefined) delete result.lifecycle;
  return result;
}

function inventory(slots: CheckoutSlot[], hostId = "host-1") {
  return { hostId, slots, instances: [], claims: [], warnings: [] };
}

function mount(
  discover: (input: { hostId: string }) => unknown,
  initial: Partial<PluginEnvironmentProviderInputsProps> = {},
) {
  const changes: PluginEnvironmentProviderInputsChange[] = [];
  function Harness() {
    const [value, setValue] = useState<PluginEnvironmentProviderInputsProps["value"]>(
      initial.value ?? null,
    );
    const [target, setTarget] = useState<PluginEnvironmentProviderInputsProps["target"]>(
      initial.target ?? { kind: "existing-host", hostId: "host-1" },
    );
    const [projectId, setProjectId] = useState(
      initial.projectId === undefined ? "project-1" : initial.projectId,
    );
    return (
      <>
        <UnitySlotInputs
          projectId={projectId}
          target={target}
          value={value}
          onChange={(next) => {
            changes.push(next);
            if (next.status === "ready") setValue(next.value);
          }}
        />
        <button onClick={() => setTarget({ kind: "existing-host", hostId: "host-2" })}>
          Change machine
        </button>
        <button onClick={() => setProjectId("project-2")}>Change project</button>
        <output aria-label="Provider inputs">{JSON.stringify(value)}</output>
      </>
    );
  }
  const result = renderSlot(
    { component: Harness },
    {},
    { rpc: { listUnityEditors: discover as never } },
  );
  fireEvent.click(result.getByLabelText("Unity checkout", { selector: "summary" }));
  return { ...result, changes };
}

test("registers checkout inputs for the Unity slot environment provider", async () => {
  const app = await loadPluginApp(() => import("./app.tsx"));
  expect(app.environmentProviderInputs).toContainEqual({
    environmentProviderId: "unity-rampage-slot",
    component: UnitySlotInputs,
  });
});

test("requires an explicit checkout and submits its registered ID", async () => {
  const result = mount(() => inventory([slot("warm-a"), slot("warm-b")]));
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({
      status: "blocked",
      reason: "Choose a checkout before starting this thread.",
    }),
  );
  expect(result.changes.some((change) => change.status === "ready")).toBe(false);
  expect(
    result
      .getByLabelText("Unity checkout", { selector: "summary" })
      .querySelector(".gs-unity-checkout-caption")?.textContent,
  ).toBe("Choose checkout");
  expect(result.rpcCalls).toEqual([{ method: "listUnityEditors", input: { hostId: "host-1" } }]);
  expect(result.queryByRole("option", { name: /Automatic/ })).toBeNull();

  fireEvent.change(result.getByRole("combobox", { name: "Unity checkout" }), {
    target: { value: "warm-b" },
  });
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({ status: "ready", value: { slotId: "warm-b" } }),
  );
  expect(result.getByLabelText("Provider inputs").textContent).toBe('{"slotId":"warm-b"}');
  expect(
    (result.getByRole("option", { name: "/work/warm-b · available" }) as HTMLOptionElement).value,
  ).toBe("warm-b");
  expect(result.queryByRole("option", { name: "inventory-warm-b" })).toBeNull();

  expect(result.changes.filter((change) => change.status === "ready")).toHaveLength(1);
  const disclosure = result.getByLabelText("Unity checkout", { selector: "summary" });
  expect(disclosure.getAttribute("title")).toBe("/work/warm-b");
  expect(disclosure.querySelector(".gs-unity-checkout-caption")?.textContent).toBe("warm-b");
  fireEvent.click(disclosure);
  expect((disclosure.closest("details") as HTMLDetailsElement).open).toBe(false);
  expect(within(disclosure).getByRole("status").textContent).toBe(
    "Unity checkout selected: /work/warm-b",
  );
  fireEvent.click(disclosure);
  expect((disclosure.closest("details") as HTMLDetailsElement).open).toBe(true);
  expect((result.getByRole("combobox") as HTMLSelectElement).value).toBe("warm-b");
});

test("lists only registered slots for the chosen project and machine", async () => {
  const foreignProject = slot("foreign-project");
  foreignProject.lifecycle!.projectId = "project-2";
  const foreignHost = slot("foreign-host", { hostId: "host-2" });
  foreignHost.lifecycle!.hostId = "host-2";
  const result = mount(() =>
    inventory([
      slot("warm"),
      slot("editor-only", { lifecycle: undefined }),
      foreignProject,
      foreignHost,
    ]),
  );
  await result.findByRole("option", { name: "/work/warm · available" });
  expect(result.getAllByRole("option")).toHaveLength(2);
  expect(result.queryByText(/foreign-project|foreign-host|editor-only/)).toBeNull();
});

test("blocks loading, ignores an old machine response, and keeps an unavailable explicit choice visible", async () => {
  let finishOld!: (value: ReturnType<typeof inventory>) => void;
  const old = new Promise<ReturnType<typeof inventory>>((resolve) => {
    finishOld = resolve;
  });
  const newSlot = slot("host-two", { hostId: "host-2" });
  newSlot.lifecycle!.hostId = "host-2";
  const result = mount(
    ({ hostId }) => (hostId === "host-1" ? old : inventory([newSlot], "host-2")),
    { value: { slotId: "old-checkout" } },
  );
  expect(result.changes.at(-1)).toEqual({ status: "blocked", reason: "Loading Unity checkouts…" });
  fireEvent.click(result.getByRole("button", { name: "Change machine" }));
  await result.findByRole("option", { name: "/work/host-two · available" });
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({
      status: "blocked",
      reason: "The selected checkout is no longer registered for this project and machine.",
    }),
  );
  finishOld(inventory([slot("old-checkout")]));
  await waitFor(() =>
    expect(
      pluginQueryClient.getQueryState([
        "game-studio",
        "unity-checkout-inputs",
        "project-1",
        "host-1",
      ])?.status,
    ).toBe("success"),
  );
  expect(result.queryByRole("option", { name: "/work/old-checkout · available" })).toBeNull();
  expect((result.getByRole("combobox") as HTMLSelectElement).value).toBe("old-checkout");
  expect(result.getByRole("option", { name: /Selected checkout unavailable/ })).toBeTruthy();
  expect(result.changes.every((change) => change.status === "blocked")).toBe(true);

  fireEvent.change(result.getByRole("combobox"), { target: { value: "host-two" } });
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({ status: "ready", value: { slotId: "host-two" } }),
  );
});

test("changing projects refetches inventory and blocks a prior project's checkout", async () => {
  const result = mount(() => inventory([slot("warm")]), { value: { slotId: "warm" } });
  await waitFor(() => expect(result.changes.at(-1)?.status).toBe("ready"));
  await waitFor(() =>
    expect(result.getByLabelText("Provider inputs").textContent).toBe('{"slotId":"warm"}'),
  );
  fireEvent.click(result.getByRole("button", { name: "Change project" }));
  await waitFor(() => expect(result.rpcCalls).toHaveLength(2));
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({
      status: "blocked",
      reason: "The selected checkout is no longer registered for this project and machine.",
    }),
  );
  expect((result.getByRole("combobox") as HTMLSelectElement).value).toBe("warm");
});

test("retains and blocks a selected checkout that becomes leased", async () => {
  let current = slot("warm");
  const result = mount(() => inventory([current]), { value: { slotId: "warm" } });
  await waitFor(() => expect(result.changes.at(-1)?.status).toBe("ready"));
  const disclosure = result.getByLabelText("Unity checkout", { selector: "summary" });
  fireEvent.click(disclosure);
  expect((disclosure.closest("details") as HTMLDetailsElement).open).toBe(false);
  current = slot("warm");
  current.lifecycle!.state = "leased";
  current.lifecycle!.ownerThreadId = "another-thread";
  await pluginQueryClient.invalidateQueries({
    queryKey: ["game-studio", "unity-checkout-inputs", "project-1", "host-1"],
  });
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({
      status: "blocked",
      reason:
        "The selected checkout is unavailable (leased). Choose another checkout or wait for it to become available.",
    }),
  );
  expect((result.getByRole("combobox") as HTMLSelectElement).value).toBe("warm");
  expect(
    (result.getByRole("option", { name: "/work/warm · leased" }) as HTMLOptionElement).disabled,
  ).toBe(true);
  expect(result.getByLabelText("Provider inputs").textContent).toBe('{"slotId":"warm"}');
  expect(disclosure.classList.contains("gs-warning")).toBe(true);
  expect(disclosure.querySelector(".gs-unity-checkout-caption")?.textContent).toBe("⚠ warm");
  expect(within(disclosure).getByRole("status").textContent).toBe(
    "The selected checkout is unavailable (leased). Choose another checkout or wait for it to become available.",
  );
  expect((disclosure.closest("details") as HTMLDetailsElement).open).toBe(false);
});

test("discovery failures block submission and Refresh can recover", async () => {
  let fail = true;
  const result = mount(() => {
    if (fail) throw new Error("machine offline");
    return inventory([slot("warm")]);
  });
  await waitFor(() =>
    expect(
      within(result.getByLabelText("Unity checkout", { selector: "summary" })).getByRole("status")
        .textContent,
    ).toBe("Could not load Unity checkouts: machine offline"),
  );
  expect(result.changes.at(-1)).toEqual({
    status: "blocked",
    reason: "Could not load Unity checkouts: machine offline",
  });
  fail = false;
  fireEvent.click(result.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({
      status: "blocked",
      reason: "Choose a checkout before starting this thread.",
    }),
  );
  fireEvent.change(result.getByRole("combobox"), { target: { value: "warm" } });
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({ status: "ready", value: { slotId: "warm" } }),
  );
});

test("an empty registered inventory stays blocked even if an unregistered Editor is discovered", async () => {
  const result = mount(() => inventory([slot("editor-only", { lifecycle: undefined })]));
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({
      status: "blocked",
      reason:
        "No Unity checkout is available for this project and machine. Register a checkout or release an existing one.",
    }),
  );
  expect(result.getAllByRole("option")).toHaveLength(1);
  expect(result.changes.some((change) => change.status === "ready")).toBe(false);
});

test("programmatic empty inputs still require an explicit UI selection", async () => {
  const result = mount(() => inventory([slot("warm")]), { value: {} });
  await waitFor(() =>
    expect(result.changes.at(-1)).toEqual({
      status: "blocked",
      reason: "Choose a checkout before starting this thread.",
    }),
  );
  expect(result.changes.some((change) => change.status === "ready")).toBe(false);
});

test("new machines and projectless compose require an existing project checkout", async () => {
  const projectless = mount(() => inventory([slot("warm")]), { projectId: null });
  expect(projectless.changes.at(-1)).toEqual({
    status: "blocked",
    reason: "Choose a BB project to select a Unity checkout.",
  });
  expect(projectless.rpcCalls).toEqual([]);
  projectless.unmount();
  const newHost = mount(() => inventory([slot("warm")]), { target: { kind: "new-host" } });
  expect(newHost.changes.at(-1)).toEqual({
    status: "blocked",
    reason: "Choose an existing machine with a registered Unity checkout.",
  });
  expect(newHost.rpcCalls).toEqual([]);
});

test("the checkout picker polls the Editor inventory only while it is open", async () => {
  const result = renderSlot(
    {
      component: () => (
        <UnitySlotInputs
          projectId="project-1"
          target={{ kind: "existing-host", hostId: "host-1" }}
          value={null}
          onChange={() => undefined}
        />
      ),
    },
    {},
    { rpc: { listUnityEditors: (() => inventory([slot("warm-a")])) as never } },
  );
  const interval = () =>
    pluginQueryClient
      .getQueryCache()
      .find({ queryKey: ["game-studio", "unity-checkout-inputs", "project-1", "host-1"] })
      ?.observers[0]?.options.refetchInterval;
  await waitFor(() => expect(result.rpcCalls).toHaveLength(1));
  // Collapsed, it reads once for its caption and readiness.
  expect(interval()).toBe(false);
  const disclosure = result.getByLabelText("Unity checkout", { selector: "summary" });
  fireEvent.click(disclosure);
  await waitFor(() => expect(interval()).toBe(5000));
  fireEvent.click(disclosure);
  await waitFor(() => expect(interval()).toBe(false));
});
