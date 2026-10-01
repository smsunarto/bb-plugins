import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";

installDom();
const { renderHook } = await import("@testing-library/react");
const { loadPluginApp } = await import("@get-bb/plugin-sdk/testing/app");
const { useSendHaptic } = await import("../src/app/send-haptic.tsx");

function installBridge(capabilities: string[]) {
  const posted: unknown[] = [];
  (window as { bb?: unknown }).bb = {
    native: { capabilities, post: (message: unknown) => posted.push(message) },
  };
  return posted;
}

afterEach(() => {
  delete (window as { bb?: unknown }).bb;
});

test("registers the send haptic as a bare thread and new-thread composer banner", async () => {
  const captured = await loadPluginApp(() => import("../src/app/app.tsx"));
  const customization = captured.composerCustomizations.find(({ id }) => id === "send-haptic");
  expect(customization?.scopes).toEqual(["thread", "new-thread"]);
  expect(customization?.banners?.map(({ id, chrome }) => ({ id, chrome }))).toEqual([
    { id: "send-haptic", chrome: "bare" },
  ]);
});

test("plays one light haptic each time the composer starts sending", () => {
  const posted = installBridge(["haptic"]);
  const { rerender } = renderHook(({ submitting }) => useSendHaptic(submitting), {
    initialProps: { submitting: false },
  });
  rerender({ submitting: true });
  rerender({ submitting: true });
  rerender({ submitting: false });
  rerender({ submitting: true });
  expect(posted).toEqual([
    { type: "haptic", kind: "impact-light" },
    { type: "haptic", kind: "impact-light" },
  ]);
});

test("stays silent when mounted mid-send or when the shell lacks haptics", () => {
  const posted = installBridge(["badge"]);
  const { rerender } = renderHook(({ submitting }) => useSendHaptic(submitting), {
    initialProps: { submitting: false },
  });
  rerender({ submitting: true });
  expect(posted).toEqual([]);

  const midSend = installBridge(["haptic"]);
  renderHook(() => useSendHaptic(true));
  expect(midSend).toEqual([]);
});
