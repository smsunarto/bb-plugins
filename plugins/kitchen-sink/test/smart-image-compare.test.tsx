import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
installDom();
const { fireEvent, waitFor } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { SmartImageCompareDirective } = await import("../src/app/smart-image-compare.tsx");

const HOUR = 3_600_000;
let threads = 0;
let hosts = 0;

/**
 * A thread whose workspace is /repo; each lease gets the next base URL. Leases
 * are cached per host root, so each fake gets its own host unless one is named.
 */
function fakeSdk(overrides: { environmentId?: string | null; path?: string; host?: string } = {}) {
  let leases = 0;
  const hostId = overrides.host ?? `host-${++hosts}`;
  return {
    threads: {
      get: async () => ({
        environmentId: "environmentId" in overrides ? overrides.environmentId : "env-1",
      }),
      storageLocation: async () => ({ hostId, storageRootPath: "/storage/thread" }),
    },
    environments: { get: async () => ({ hostId, path: overrides.path ?? "/repo" }) },
    files: {
      createPreview: async () => ({
        baseUrl: `/api/v1/previews/lease-${++leases}`,
        expiresAtMs: Date.now() + HOUR,
      }),
    },
  };
}

function renderComparison(
  attributes: Record<string, string>,
  sdk = fakeSdk(),
  threadId = `thread-${++threads}`,
) {
  return renderSlot(
    { component: SmartImageCompareDirective },
    {
      attributes,
      message: { id: "message", threadId, turnId: "turn", projectId: "project" },
      source: "::smart-image-compare{}",
      openWorkspaceFile: null,
    },
    { sdk: sdk as never },
  );
}

function previewCalls(view: ReturnType<typeof renderComparison>) {
  return view.inspection.sdkCalls.filter((call) => call.method === "files.createPreview");
}

test("loads workspace images through a preview lease on the thread's worktree", async () => {
  const view = renderComparison(
    { before: "screens/before #1.png", after: "https://example.com/image.png" },
    fakeSdk({ host: "host-workspace" }),
  );
  const before = view.getByAltText("Before") as HTMLImageElement;
  await waitFor(() =>
    expect(before.getAttribute("src")).toBe("/api/v1/previews/lease-1/screens/before%20%231.png"),
  );
  expect(view.getByAltText("After").getAttribute("src")).toBe("https://example.com/image.png");
  expect(previewCalls(view).map((call) => call.args[0])).toEqual([
    { hostId: "host-workspace", rootPath: "/repo" },
  ]);
  view.unmount();
});

test("loads thread-storage images through a lease on the thread's storage root", async () => {
  const view = renderComparison(
    { before: "a.png", after: "b.png", source: "thread-storage" },
    fakeSdk({ host: "host-storage" }),
  );
  await waitFor(() =>
    expect(view.getByAltText("After").getAttribute("src")).toBe("/api/v1/previews/lease-1/b.png"),
  );
  expect(previewCalls(view).map((call) => call.args[0])).toEqual([
    { hostId: "host-storage", rootPath: "/storage/thread" },
  ]);
  view.unmount();
});

test("renews the lease once when an image fails, then names the image that cannot load", async () => {
  const view = renderComparison({ before: "a.png", after: "b.png", afterLabel: "Updated" });
  const after = view.getByAltText("Updated");
  await waitFor(() => expect(after.getAttribute("src")).toBe("/api/v1/previews/lease-1/b.png"));
  fireEvent.error(after);
  await waitFor(() => expect(after.getAttribute("src")).toBe("/api/v1/previews/lease-2/b.png"));
  expect(view.queryByRole("alert")).toBeNull();
  fireEvent.error(after);
  expect(view.getByRole("alert").textContent).toBe(
    "Could not load the Updated image. Check its path and access permissions.",
  );
  expect(previewCalls(view)).toHaveLength(2);
  view.unmount();
});

test("reports a failed remote image at once without renewing the local lease", async () => {
  const view = renderComparison({ before: "a.png", after: "https://example.com/missing.png" });
  await waitFor(() =>
    expect(view.getByAltText("Before").getAttribute("src")).toBe("/api/v1/previews/lease-1/a.png"),
  );
  fireEvent.error(view.getByAltText("After"));
  expect(view.getByRole("alert").textContent).toBe(
    "Could not load the After image. Check its path and access permissions.",
  );
  expect(previewCalls(view)).toHaveLength(1);
  view.unmount();
});

test("leases the thread's current workspace after it moves", async () => {
  const first = renderComparison(
    { before: "a.png", after: "b.png" },
    fakeSdk({ host: "host-moving" }),
    "moving-thread",
  );
  await waitFor(() => expect(previewCalls(first)).toHaveLength(1));
  first.unmount();
  const moved = renderComparison(
    { before: "a.png", after: "b.png" },
    fakeSdk({ host: "host-moving", path: "/repo-moved" }),
    "moving-thread",
  );
  await waitFor(() =>
    expect(previewCalls(moved).map((call) => call.args[0])).toEqual([
      { hostId: "host-moving", rootPath: "/repo-moved" },
    ]),
  );
  moved.unmount();
});

test("reports a thread without a workspace instead of loading images", async () => {
  const view = renderComparison(
    { before: "a.png", after: "b.png" },
    fakeSdk({ environmentId: null }),
  );
  expect((await view.findByRole("alert")).textContent).toBe(
    "Could not open this thread's images: This thread has no workspace.",
  );
  expect(view.getByAltText("Before").getAttribute("src")).toBeNull();
  view.unmount();
});

test("rejects paths that escape the workspace and credentialed URLs", () => {
  for (const path of [
    "../secret.png",
    "/tmp/image.png",
    "javascript:alert(1)",
    "file:///tmp/a",
    "https://user:pass@example.com/a",
  ]) {
    const view = renderComparison({ before: path, after: "b.png" });
    expect(view.getByRole("alert")).toBeDefined();
    expect(view.queryByRole("slider")).toBeNull();
    view.unmount();
  }
});

test("renders custom labels and reports unequal dimensions", () => {
  const view = renderComparison({
    before: "before.png",
    after: "after.png",
    beforeLabel: "Original",
    afterLabel: "Updated",
  });
  expect(view.getByText("Original")).toBeDefined();
  expect(view.getByText("Updated")).toBeDefined();
  const before = view.getByAltText("Original");
  const after = view.getByAltText("Updated");
  Object.defineProperties(before, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  Object.defineProperties(after, { naturalWidth: { value: 1600 }, naturalHeight: { value: 900 } });
  fireEvent.load(before);
  fireEvent.load(after);
  expect(view.getByRole("alert").textContent).toContain("800×600 and 1600×900");
  expect(view.getByRole("slider")).toBeDefined();
  view.unmount();
});

test("defaults labels and rejects invalid source or missing image", () => {
  const valid = renderComparison({ before: "a.png", after: "b.png" });
  expect(valid.getByAltText("Before")).toBeDefined();
  expect(valid.getByAltText("After")).toBeDefined();
  valid.unmount();
  const invalidAttributes: Record<string, string>[] = [
    { before: "a.png" },
    { before: "a.png", after: "b.png", source: "outside" },
  ];
  for (const attributes of invalidAttributes) {
    const invalid = renderComparison(attributes);
    expect(invalid.getByRole("alert")).toBeDefined();
    expect(invalid.queryByRole("slider")).toBeNull();
    invalid.unmount();
  }
});

test("places agent callouts on their chosen image with normalized coordinates", () => {
  const view = renderComparison({
    before: "a.png",
    after: "b.png",
    annotations: JSON.stringify([
      { x: 25, y: 40, label: "Old background", side: "before" },
      { x: 75, y: 40, label: "Background removed", side: "after" },
      { x: 50, y: 60, label: "Subject stays aligned" },
    ]),
  });
  const before = view.container.querySelector('[data-rcs-item="itemOne"]')!;
  const after = view.container.querySelector('[data-rcs-item="itemTwo"]')!;
  expect(before.querySelector('[aria-label="Annotation 1: Old background"]')).not.toBeNull();
  expect(before.querySelector('[aria-label="Annotation 2: Background removed"]')).toBeNull();
  expect(after.querySelector('[aria-label="Annotation 2: Background removed"]')).not.toBeNull();
  expect(after.querySelector('[aria-label="Annotation 1: Old background"]')).toBeNull();
  expect(before.querySelector('[aria-label="Annotation 3: Subject stays aligned"]')).not.toBeNull();
  expect(after.querySelector('[aria-label="Annotation 3: Subject stays aligned"]')).not.toBeNull();
  const pin = before.querySelector("button")!;
  expect(pin.style.left).toBe("25%");
  expect(pin.style.top).toBe("40%");
  fireEvent.click(pin);
  expect(view.getByRole("status").textContent).toContain("Old background");
  expect(pin.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(view.getByRole("button", { name: "Close annotation" }));
  expect(view.queryByRole("status")).toBeNull();
  view.unmount();
});

test("rejects malformed annotation coordinates and payloads without rendering the slider", () => {
  for (const annotations of [
    "not-json",
    "null",
    '[{"x":101,"y":20,"label":"Outside"}]',
    '[{"x":20,"y":20,"label":""}]',
    '[{"x":20,"y":20,"label":"Text","side":"unknown"}]',
  ]) {
    const view = renderComparison({ before: "a.png", after: "b.png", annotations });
    expect(view.getByRole("alert").textContent).toContain("Coordinates are percentages");
    expect(view.queryByRole("slider")).toBeNull();
    view.unmount();
  }
});
