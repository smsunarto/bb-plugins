// @vitest-environment jsdom
import type { BbNavigate } from "@get-bb/plugin-sdk/app";
import { describe, expect, it, vi } from "vitest";
import type { ReviewDiffViewHandle } from "../../shared/vendor/review-protocol/src/index.ts";
import type { WhiteboardRpcClient } from "../rpc.ts";

const inner = vi.hoisted(() => ({
  handles: [] as Array<{ revealFile: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>,
}));

// WP6 owns the real factories; the bridge only forwards to them.
vi.mock("./diff-view.tsx", () => ({
  createDiffView: () => ({
    create: () => {
      const handle = {
        focus: vi.fn(),
        onDidError: vi.fn(() => ({ dispose() {} })),
        dispose: vi.fn(),
        revealFile: vi.fn(),
      };
      inner.handles.push(handle);
      return handle;
    },
    files: vi.fn(),
  }),
}));
vi.mock("./inline-editors.tsx", () => ({ createInlineEditors: () => ({}) }));
vi.mock("../vendor/generated/libavoid-wasm.ts", () => ({ LIBAVOID_WASM: "" }));

const { createBbBridge, PLACEHOLDER_SERVER_URL } = await import("./bb-bridge.ts");
const { createSurfaceEvents } = await import("./events.ts");
const { createLiveHub } = await import("./live-watch.ts");
const { createPortals } = await import("./portals.tsx");

function bridgeWith(info = { softwareMapEnabled: false }) {
  const deps = {
    rpc: { api: vi.fn() } as unknown as WhiteboardRpcClient,
    threadId: "thread-1",
    reviewId: "s1",
    navigate: { openUrl: vi.fn(() => true) } as unknown as BbNavigate,
    info: { appVersion: "", scratchpadEnabled: false, structuralDiffEnabled: false, ...info },
    portals: createPortals(),
    events: createSurfaceEvents(),
    hub: createLiveHub(),
  };
  return { bridge: createBbBridge(deps), deps };
}

describe("createBbBridge", () => {
  it("names the session and a placeholder server the tunnel strips", () => {
    const { bridge } = bridgeWith();
    expect(bridge.config).toMatchObject({
      host: "desktop",
      serverUrl: PLACEHOLDER_SERVER_URL,
      reviewId: "s1",
      appVersion: "0.0.0",
    });
  });

  it("reads info flags per call, so settings changes reach a live bridge", async () => {
    const { bridge, deps } = bridgeWith();
    const ask = () => bridge.post!({ name: "authoringCapabilities", args: {} });
    expect(await ask()).toEqual({ ok: true, result: { softwareMapEnabled: false } });
    deps.info.softwareMapEnabled = true;
    expect(await ask()).toEqual({ ok: true, result: { softwareMapEnabled: true } });
  });

  it("reveals an openDiff file in the next Diffs view when none exists yet", async () => {
    inner.handles.length = 0;
    const { bridge } = bridgeWith();
    await bridge.post!({ name: "openDiff", args: { path: "src/a.ts" } });
    const handle: ReviewDiffViewHandle = bridge.diffView.create({} as never);
    expect(inner.handles[0]!.revealFile).toHaveBeenCalledWith("src/a.ts");

    await bridge.post!({ name: "openDiff", args: { path: "src/b.ts" } });
    expect(inner.handles[0]!.revealFile).toHaveBeenLastCalledWith("src/b.ts");

    handle.dispose();
    expect(inner.handles[0]!.dispose).toHaveBeenCalled();
    await bridge.post!({ name: "openDiff", args: { path: "src/c.ts" } });
    expect(inner.handles[0]!.revealFile).toHaveBeenCalledTimes(2);
  });
});
