import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers/plugin-app-runtime.ts";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup } from "@testing-library/react";
import * as appModule from "../app.tsx";

const app = await loadPluginApp(appModule);

const AMP_LOGO = "https://cdn.example/amp.svg";
const CLAUDE_LOGO = "https://cdn.example/claude.svg";

const AMP = { displayName: "Amp", id: "acp-amp", logoUrl: AMP_LOGO };
const CLAUDE = { displayName: "Claude Code", id: "acp-claude", logoUrl: CLAUDE_LOGO };

const toggleAction = (() => {
  const customization = app.composerCustomizations.find((entry) => entry.id === "orb-toggle");
  assert.ok(customization, "the orb-toggle composer customization is registered");
  const action = customization.actions?.find((entry) => entry.id === "orb-toggle");
  assert.ok(action, "the orb-toggle action is registered");
  return action;
})();

/** Paints the host markers the gate reads: a `[data-provider-logo]` mask span
 *  for the selected provider, inside a `[data-app-composer]` shell. Returns
 *  the shell so a test can move the toggle out of it. */
function paintComposer(selected: { logoUrl: string }): HTMLElement {
  const doc = globalThis.document;
  doc.body.innerHTML = "";
  doc.body.removeAttribute("data-app-composer");
  const shell = doc.createElement("div");
  shell.setAttribute("data-app-composer", "");
  const mark = doc.createElement("span");
  mark.setAttribute("data-provider-logo", selected.logoUrl);
  shell.append(mark);
  doc.body.append(shell);
  return shell;
}

/** Mounts the toggle as a descendant of the composer shell, which is where
 *  the host renders it for the first three plugin groups. */
function renderInComposer(
  selected: { logoUrl: string },
  options: Parameters<typeof renderSlot>[2],
) {
  paintComposer(selected);
  globalThis.document.body.setAttribute("data-app-composer", "");
  return renderSlot(toggleAction, {}, options);
}

function orbButton(): HTMLElement | null {
  return globalThis.document.querySelector(".amp-orb-toggle");
}

const ready = (providers: unknown[]) => ({ providers, status: "ready" as const });

test("a provider directory error keeps the toggle off a non-Amp composer", async () => {
  paintComposer(CLAUDE);
  globalThis.document.body.setAttribute("data-app-composer", "");
  const slot = renderSlot(
    toggleAction,
    {},
    { providers: { providers: [], status: "error" } } as never,
  );
  await act(async () => {});
  // status is "error", not "loading", so the old guard fell through to the
  // fail-open branch and armed Orb from a Claude composer.
  assert.equal(orbButton(), null);
  slot.unmount();
  cleanup();
});

test("an unregistered Amp provider hides the toggle instead of failing open", async () => {
  const slot = renderInComposer(CLAUDE, {
    providers: ready([CLAUDE]),
  } as never);
  await act(async () => {});
  assert.equal(orbButton(), null);
  slot.unmount();
  cleanup();
});

test("the toggle still gates when the host portals it out of the composer", async () => {
  const shell = paintComposer(CLAUDE);
  void shell;
  const slot = renderSlot(toggleAction, {}, { providers: ready([AMP, CLAUDE]) } as never);
  await act(async () => {});
  // Past the third plugin group the host portals composer actions to <body>,
  // so `closest("[data-app-composer]")` is null and the shell above is a
  // sibling. Claude is selected, so the toggle must stay hidden.
  assert.equal(orbButton(), null);
  slot.unmount();
  cleanup();
});

test("a marker flicker does not silently disarm the intent", async () => {
  const slot = renderInComposer(AMP, {
    providers: ready([AMP, CLAUDE]),
    rpc: { getOrbIntent: () => ({ armed: false }), setOrbIntent: () => ({ armed: true }) },
  } as never);
  await act(async () => {});
  assert.ok(orbButton(), "the toggle is visible while Amp is selected");
  await act(async () => {
    orbButton()?.click();
  });
  const mark = globalThis.document.querySelector("[data-provider-logo]");
  await act(async () => {
    mark?.remove();
  });
  await act(async () => {
    const shell = globalThis.document.querySelector("[data-app-composer]");
    const back = globalThis.document.createElement("span");
    back.setAttribute("data-provider-logo", AMP_LOGO);
    shell?.append(back);
  });
  const disarms = slot.inspection.rpcCalls.filter(
    (entry) =>
      entry.method === "setOrbIntent" && (entry.input as { armed: boolean }).armed === false,
  );
  // The host drops and repaints the picker markers across a task change. The
  // arm must survive it; only a press or the TTL clears the intent.
  assert.deepEqual(disarms, []);
  slot.unmount();
  cleanup();
});

test("a press outranks a getOrbIntent answer already in flight", async () => {
  let release: (() => void) | null = null;
  const slot = renderInComposer(AMP, {
    providers: ready([AMP, CLAUDE]),
    rpc: {
      getOrbIntent: () =>
        new Promise<{ armed: boolean }>((resolve) => {
          release = () => resolve({ armed: false });
        }),
      setOrbIntent: () => ({ armed: true }),
    },
  } as never);
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
