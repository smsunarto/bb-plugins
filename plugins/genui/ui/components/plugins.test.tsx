// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type * as PluginSdkApp from "@get-bb/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginInfo } from "../../core/plugins";
import type { PluginsResult } from "../../core/project";
import { UiRuntimeContext, type UiRuntime } from "../runtime";
import type { Props } from "../values";
import { Plugins } from "./plugins";

const calls: { method: string; input: { ids: string[] } }[] = [];
let settle: (answer: PluginsResult) => void = () => {};

vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof PluginSdkApp>()),
  experimental_Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  experimental_PluginIcon: ({ pluginId }: { pluginId: string }) => (
    <i data-plugin-icon={pluginId} />
  ),
  useRpc: () => ({
    call: (method: string, input: { ids: string[] }) => {
      calls.push({ method, input });
      return new Promise<PluginsResult>((resolve) => (settle = resolve));
    },
  }),
}));

function plugin(id: string, overrides: Partial<PluginInfo> = {}): PluginInfo {
  return {
    found: true,
    id,
    name: id,
    version: "0.1.0",
    icon: null,
    source: `path · ~/plugins/${id}`,
    sourceNotice: null,
    status: "running",
    statusDetail: null,
    ...overrides,
  };
}

/** No thread: Plugins reads BB itself, so it renders in the gallery too. */
function runtime(): UiRuntime {
  return {
    setValue() {},
    async run() {},
    openFile: null,
    loadImage: null,
    holdHeight: () => () => {},
    readText: null,
    loadAudio: null,
    loadVideo: null,
    loadAsset: null,
    superseded: false,
    threadId: null,
    blockKey: null,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(Element.prototype, "animate", {
    configurable: true,
    value: () => ({ cancel() {} }),
  });
  calls.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function render(props: Props) {
  act(() =>
    root.render(
      <UiRuntimeContext value={runtime()}>
        <Plugins props={props} />
      </UiRuntimeContext>,
    ),
  );
}

const rows = () => [...container.querySelectorAll("li")].map((row) => row.textContent);

describe("Plugins", () => {
  it("asks BB once for the ids named and shows each claim beside BB's state", async () => {
    render({
      items: [
        { id: "genui", action: "reloaded" },
        { id: "source-control", action: "not-reloaded", note: "type-check fails" },
        { id: "old", action: "removed" },
        { id: "gone", action: "removed" },
      ],
    });
    expect(calls).toEqual([
      { method: "project_plugins", input: { ids: ["genui", "source-control", "old", "gone"] } },
    ]);
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Loading plugins",
    );
    await act(async () =>
      settle({
        ok: true,
        plugins: [
          plugin("genui", { name: "Generative UI", version: "0.3.2" }),
          plugin("source-control"),
          plugin("old"),
          { found: false, id: "gone" },
        ],
        fetchedAt: Date.now(),
      }),
    );
    expect(rows()).toEqual([
      "Generative UIgenuiv0.3.2ReloadedRunning·path · ~/plugins/genui",
      "source-controlv0.1.0Not reloadedRunning·path · ~/plugins/source-controltype-check fails",
      "oldv0.1.0RemovedRunning·path · ~/plugins/oldStill installed.",
      "goneRemovedNot installed",
    ]);
    expect(container.querySelector("header")?.textContent).toContain("1 needs attention");
    expect(container.querySelector('[data-plugin-icon="genui"]')).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("says why when BB can't list its plugins, and what is wrong with unreadable items", async () => {
    render({ items: [{ id: "solo-fail", action: "reloaded" }] });
    await act(async () =>
      settle({
        ok: false,
        reason: "unavailable",
        message: "BB couldn't list its plugins: timeout",
      }),
    );
    expect(container.textContent).toContain("BB couldn't list its plugins: timeout");
    render({ items: [{ id: "genui", action: "restarted" }] });
    expect(container.textContent).toContain(
      '"genui" needs action installed, reloaded, removed or not-reloaded',
    );
  });
});
