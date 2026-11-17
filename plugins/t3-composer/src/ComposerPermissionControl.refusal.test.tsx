// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bb,
  openThread,
  pick,
  renderControl,
  resetFakeComposer,
  trigger,
  setControl,
} from "./permission-test-composer";
// workaround:t3-composer/thread-permission-reset begin
import { forgetAllPermissionModes } from "./thread-permission-picks";
// workaround:t3-composer/thread-permission-reset end

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

describe("ComposerPermissionControl's refusal message", () => {
  beforeEach(() => resetFakeComposer(["full"]));
  afterEach(() => {
    cleanup();
    // workaround:t3-composer/thread-permission-reset begin
    forgetAllPermissionModes();
    // workaround:t3-composer/thread-permission-reset end
  });

  it("clears once the mode changes", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    await waitFor(() => expect(trigger().textContent).toContain("Accept Edits"));
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("clears on a thread switch", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    openThread("b");
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("stays off the thread opened while the refused pick was pending", async () => {
    renderControl();
    bb.hold = { release() {} };
    await pick(/Full Access/);
    openThread("b");
    await act(async () => bb.hold?.release());
    await waitFor(() => expect(bb.calls).toHaveLength(1));
    expect(screen.queryByText(REFUSED)).toBeNull();
  });

  it("clears on the next pick", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    bb.hold = { release() {} };
    await pick(/Accept Edits/);
    expect(screen.queryByText(REFUSED)).toBeNull();
    await act(async () => bb.hold?.release());
  });

  it("does not come back when the mode returns to the refused value", async () => {
    renderControl();
    await pick(/Full Access/);
    await screen.findByText(REFUSED);

    await act(() => bb.composer!.setSelection({ permissionMode: "accept-edits" }));
    await act(() => bb.composer!.setSelection({ permissionMode: "auto" }));
    await waitFor(() => expect(trigger().textContent).toContain("Approve for me"));
    expect(screen.queryByText(REFUSED)).toBeNull();
  });
});
