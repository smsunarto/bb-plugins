// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UiRuntimeContext, type UiRuntime, type VideoUrl } from "../runtime";
import { Video } from "./Video";

vi.mock("@get-bb/plugin-sdk/app", async (original) => ({
  ...(await original<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_usePluginId: () => "genui-test",
}));
const bytes: VideoUrl = { ok: true, url: "blob:first", expiresAtMs: null, owned: true };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let load: ReturnType<typeof vi.fn<(path: string) => Promise<VideoUrl>>>;
let runtime: UiRuntime;
const revoke = vi.fn();
const create = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
  create.mockReset().mockReturnValueOnce("blob:first").mockReturnValueOnce("blob:second");
  revoke.mockReset();
  load = vi.fn(async () => bytes);
  runtime = {
    setValue() {},
    async run() {},
    openFile: null,
    loadImage: null,
    holdHeight: () => () => {},
    readText: null,
    loadAudio: null,
    loadAsset: null,
    loadVideo: load,
    superseded: false,
    threadId: "thread-a",
    blockKey: null,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(src: string) {
  await act(async () =>
    root.render(
      <UiRuntimeContext value={runtime}>
        <Video props={{ src, caption: "Demo" }} />
      </UiRuntimeContext>,
    ),
  );
}
it("keeps native controls when enhancement fails and never autoplays", async () => {
  await render("a.mp4");
  const video = container.querySelector("video")!;
  expect(video.src).toBe("blob:first");
  expect(video.controls).toBe(true);
  expect(video.autoplay).toBe(false);
  expect(video.playsInline).toBe(true);
  expect(container.textContent).toContain("Demo");
});
it("releases the previous clip and resets a decode error on source replacement", async () => {
  await render("a.mp4");
  await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
  expect(container.textContent).toContain("could not be loaded");
  load.mockResolvedValueOnce({ ok: true, url: "blob:second", expiresAtMs: null, owned: true });
  await render("b.mp4");
  expect(revoke).toHaveBeenCalledWith("blob:first");
  expect(container.querySelector("video")!.src).toBe("blob:second");
  act(() => root.render(null));
  expect(revoke).toHaveBeenCalledWith("blob:second");
});
it("ignores a late load after replacement", async () => {
  let finish!: (result: VideoUrl) => void;
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render("slow.mp4");
  await render("ready.mp4");
  await act(async () => finish(bytes));
  expect(revoke).toHaveBeenCalledWith("blob:first");
  expect(container.querySelector("video")!.src).toBe("blob:first");
});
it("does not read network URLs and reports host failures", async () => {
  await render("https://example.com/a.mp4");
  expect(load).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Download remote clips");
  load.mockResolvedValueOnce({ ok: false, error: "host offline" });
  await render("a.mp4");
  expect(container.textContent).toContain("host offline");
});

it("recovers two expired leases, preserving position, and bounds unsuccessful renewal", async () => {
  let issued = 0;
  load.mockImplementation(async () => ({
    ok: true,
    url: `https://bb.test/lease-${++issued}`,
    expiresAtMs: Date.now() - 1,
    owned: false,
  }));
  await render("a.mp4");
  for (const time of [12, 24]) {
    const video = container.querySelector("video")!;
    video.currentTime = time;
    await act(async () => video.dispatchEvent(new Event("error")));
    const replacement = container.querySelector("video")!;
    act(() => {
      replacement.dispatchEvent(new Event("loadedmetadata"));
      replacement.dispatchEvent(new Event("canplay"));
    });
    expect(replacement.currentTime).toBe(time);
  }
  expect(load).toHaveBeenCalledTimes(3);
  expect(load).toHaveBeenLastCalledWith("a.mp4", true);
  await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
  await act(async () => container.querySelector("video")!.dispatchEvent(new Event("error")));
  expect(load).toHaveBeenCalledTimes(4);
  expect(container.textContent).toContain("expired");
  expect(container.textContent).toContain("Retry video");
});
