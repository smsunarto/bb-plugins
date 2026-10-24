import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers/plugin-app-runtime.ts";
import { createElement, Fragment } from "react";
import { useComposer, type ComposerSelection } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent } from "@testing-library/react";
import * as appModule from "../app.tsx";
import { AMP_AGENT } from "../src/execution-target.ts";

const app = await loadPluginApp(appModule);

const toggleAction = (() => {
  const customization = app.composerCustomizations.find((entry) => entry.id === "orb-toggle");
  assert.ok(customization, "the orb-toggle composer customization is registered");
  const action = customization.actions?.find((entry) => entry.id === "orb-toggle");
  assert.ok(action, "the orb-toggle action is registered");
  return action;
})();

const NEW_THREAD = { kind: "new-thread", projectId: "prj_1" } as const;
const AMP_SELECTED: ComposerSelection = { providerId: AMP_AGENT.providerId, model: "smart" };
const CLAUDE_SELECTED: ComposerSelection = { providerId: "claude-code" };

/** The toggle beside buttons that pick a provider the way the user would. */
function ToggleWithPicker() {
  const composer = useComposer();
  const pick = (providerId: string) => () => void composer.setSelection({ providerId });
  return createElement(
    Fragment,
    null,
    createElement("button", { onClick: pick(AMP_AGENT.providerId), type: "button" }, "Pick Amp"),
    createElement("button", { onClick: pick("claude-code"), type: "button" }, "Pick Claude"),
    createElement(toggleAction.component),
  );
}

function renderToggle(
  selection: ComposerSelection | undefined,
  rpc: Record<string, (input: unknown) => unknown> = { getOrbIntent: () => ({ armed: false }) },
) {
  return renderSlot(
    { component: ToggleWithPicker },
    {},
    {
      composer: { scope: NEW_THREAD, ...(selection === undefined ? {} : { selection }) },
      rpc,
    },
  );
}

function orbButton(): HTMLElement | null {
  return globalThis.document.querySelector(".amp-orb-toggle");
}

test("the toggle shows only while the composer's selected provider is Amp", async () => {
  for (const [selection, visible] of [
    [AMP_SELECTED, true],
    [CLAUDE_SELECTED, false],
    // An unresolved picker cannot say Amp is selected, so Orb stays off it.
    [undefined, false],
  ] as const) {
    const slot = renderToggle(selection);
    await act(async () => {});
    assert.equal(orbButton() !== null, visible, `providerId ${selection?.providerId}`);
    slot.unmount();
    cleanup();
  }
});

test("switching providers away and back keeps the arm and re-reads it", async () => {
  const slot = renderToggle(AMP_SELECTED, {
    getOrbIntent: () => ({ armed: true }),
    setOrbIntent: () => ({ armed: true }),
  });
  await act(async () => {});
  assert.equal(orbButton()?.getAttribute("aria-pressed"), "true");
  await act(async () => {
    fireEvent.click(slot.getByText("Pick Claude"));
  });
  assert.equal(orbButton(), null);
  await act(async () => {
    fireEvent.click(slot.getByText("Pick Amp"));
  });
  assert.equal(orbButton()?.getAttribute("aria-pressed"), "true");
  const calls = slot.inspection.rpcCalls.map((entry) => entry.method);
  // Leaving Amp never disarms; only a press or the TTL clears the intent.
  assert.deepEqual(
    calls.filter((method) => method === "setOrbIntent"),
    [],
  );
  assert.equal(calls.filter((method) => method === "getOrbIntent").length, 2);
  slot.unmount();
  cleanup();
});

test("a failed press does not roll back a newer press", async () => {
  const rejects: Array<() => void> = [];
  const slot = renderToggle(AMP_SELECTED, {
    getOrbIntent: () => ({ armed: false }),
    setOrbIntent: () =>
      new Promise<{ armed: boolean }>((_resolve, reject) => {
        rejects.push(() => reject(new Error("offline")));
      }),
  });
  await act(async () => {});
  for (let press = 0; press < 3; press += 1) {
    await act(async () => {
      orbButton()?.click();
    });
  }
  assert.equal(orbButton()?.getAttribute("aria-pressed"), "true");
  await act(async () => {
    rejects[0]?.();
  });
  // The first press asked for armed:true, so its rollback wrote false. Two
  // presses later the user is back on true, and a stale failure must not
  // reach back and undo that.
  assert.equal(orbButton()?.getAttribute("aria-pressed"), "true");
  slot.unmount();
  cleanup();
});

test("a press outranks a getOrbIntent answer already in flight", async () => {
  let release: (() => void) | null = null;
  const slot = renderToggle(AMP_SELECTED, {
    getOrbIntent: () =>
      new Promise<{ armed: boolean }>((resolve) => {
        release = () => resolve({ armed: false });
      }),
    setOrbIntent: () => ({ armed: true }),
  });
  await act(async () => {});
  await act(async () => {
    orbButton()?.click();
  });
  assert.equal(orbButton()?.getAttribute("aria-pressed"), "true");
  await act(async () => {
    release?.();
  });
  // The answer describes the state the press replaced. Applying it would read
  // "off" while the server is armed, and the next thread would run on Orb.
  assert.equal(orbButton()?.getAttribute("aria-pressed"), "true");
  slot.unmount();
  cleanup();
});
