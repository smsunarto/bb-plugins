// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bb,
  openThread,
  pick,
  publish,
  renderControl,
  resetFakeComposer,
  setCeiling,
  trigger,
  setControl,
} from "./permission-test-composer";
import { forgetAllPermissionModes, keptPermissionMode } from "./thread-permission-picks";

vi.mock(
  "./composer-handle",
  async () => (await import("./permission-test-composer")).composerHandleMock,
);
vi.mock(
  "./model-picker/catalog",
  async () => (await import("./permission-test-composer")).catalogMock,
);
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => {
  const { fakeSdk } = await import("./permission-test-composer");
  const sdk = fakeSdk();
  return {
    ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
    useSdk: () => sdk,
  };
});

setControl((await import("./ComposerPermissionControl")).ComposerPermissionControl);

const REFUSED = "BB kept the current permission mode.";

describe("useKeptPermissionMode", () => {
  beforeEach(() => resetFakeComposer());
  afterEach(() => {
    cleanup();
    forgetAllPermissionModes();
  });

  it("keeps a thread's pick when you open another thread and come back", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("keeps the pick when the control mounts again for the thread", async () => {
    const first = renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
    first.unmount();

    openThread("b");
    const second = renderControl();
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    second.unmount();

    openThread("a");
    renderControl();
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("restores once the machine answers after the switch", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    bb.machineKnown = false;
    openThread("a");
    expect(trigger().textContent).toContain("Approve for me");
    act(() => {
      bb.machineKnown = true;
      publish();
    });
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("starts a new thread at BB's default mode", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread(null);
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    expect(bb.calls).toEqual([{ permissionMode: "full" }]);
  });

  it("settles a kept pick under a machine limit lowered while away", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    setCeiling("accept-edits");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
  });

  it("does not revert a change made after the restore", async () => {
    renderControl();
    await pick(/Full Access/);
    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    // Like BB's own cycle shortcut or a `#` keyword.
    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
    expect(keptPermissionMode("a")).toBe("accept-edits");

    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
  });

  it("still restores a thread after a mode was refused on another", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    bb.refuses.add("full");
    await pick(/Full Access/);
    await screen.findByText(REFUSED);
    bb.refuses.clear();

    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("leaves the mode to BB once a turn starts on the thread", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(keptPermissionMode("a")).toBe("full"));

    act(() => bb.turns.get("a")?.("item/agentMessage/delta"));
    expect(keptPermissionMode("a")).toBe("full");
    // Another client sends a turn with its own mode; BB now resets the thread to that one.
    act(() => bb.turns.get("a")?.("turn/started"));
    expect(keptPermissionMode("a")).toBeUndefined();
    bb.defaults.set("a", "accept-edits");
    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
  });

  it("keeps a mode set outside the picker, without a pick before it", async () => {
    renderControl();
    // A `#full` keyword or BB's own controls.
    await act(() => bb.composer!.setSelection({ permissionMode: "full" }));
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("gives way to a mode sent while this page heard nothing of it", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    // A turn sent elsewhere at Accept Edits while this page was offline: no event arrives.
    bb.defaults.set("a", "accept-edits");
    openThread("a");
    await waitFor(() => expect(keptPermissionMode("a")).toBeUndefined());
    expect(trigger().textContent).toContain("Accept Edits");
    expect(bb.calls).toEqual([{ permissionMode: "full" }]);
  });

  it("gives way to BB after the connection drops, when a missed turn can't be seen", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    // A turn sent elsewhere at A's last sent mode while the socket was down.
    act(() => bb.connection?.("disconnected"));
    act(() => bb.connection?.("connected"));
    openThread("a");
    await act(async () => {});
    expect(trigger().textContent).toContain("Approve for me");
    expect(keptPermissionMode("a")).toBeUndefined();
    expect(bb.connection).toBeNull();
  });

  it("keeps a mode chosen while the connection was down, and drops older ones", async () => {
    openThread("b");
    renderControl();
    await pick(/Accept Edits/);
    await waitFor(() => expect(keptPermissionMode("b")).toBe("accept-edits"));

    openThread("a");
    act(() => bb.connection?.("disconnected"));
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
    // BB retries with backoff before it reconnects.
    act(() => bb.connection?.("connecting"));
    act(() => bb.connection?.("disconnected"));
    act(() => bb.connection?.("connected"));

    expect(keptPermissionMode("b")).toBeUndefined();
    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("keeps a mode first chosen while the connection is down", async () => {
    // Nothing is kept yet, so the watch on BB's connection starts during the drop.
    bb.connectionState = "disconnected";
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
    act(() => bb.connection?.("connecting"));
    act(() => bb.connection?.("connected"));

    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
  });

  it("keeps a mode chosen before the machine's limit arrives", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));

    openThread("b");
    bb.machineKnown = false;
    openThread("a");
    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    act(() => {
      bb.machineKnown = true;
      publish();
    });
    await act(async () => {});
    expect(trigger().textContent).toContain("Accept Edits");
    expect(keptPermissionMode("a")).toBe("accept-edits");
  });

  it("does not restore over a change made while the control was unmounted", async () => {
    const first = renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
    first.unmount();

    // The phone composer collapses; the mode changes in BB meanwhile.
    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    renderControl();
    await act(async () => {});
    expect(trigger().textContent).toContain("Accept Edits");
    expect(bb.calls.at(-1)).toEqual({ permissionMode: "accept-edits" });
  });

  it("restores nothing on a re-render", async () => {
    renderControl();
    await pick(/Full Access/);
    openThread("b");
    openThread("a");
    await waitFor(() => expect(trigger().textContent).toContain("Full Access"));
    const calls = bb.calls.length;
    for (let i = 0; i < 3; i += 1) act(() => publish());
    expect(bb.calls).toHaveLength(calls);
  });

  it("keeps no pick BB refused", async () => {
    bb.refuses.add("full");
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);
    expect(keptPermissionMode("a")).toBeUndefined();
  });

  it("forgets a thread's pick once BB deletes the thread", async () => {
    renderControl();
    await pick(/Full Access/);
    await waitFor(() => expect(keptPermissionMode("a")).toBe("full"));

    act(() => bb.deleted.get("a")?.());
    expect(keptPermissionMode("a")).toBeUndefined();
  });
});
