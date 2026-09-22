import { expect, test } from "bun:test";
import { installDom } from "@bb-kit/core/testing";
installDom();
const { fireEvent } = await import("@testing-library/react");
const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { SmartImageCompareDirective, imageCompareUrl } =
  await import("../src/app/smart-image-compare.tsx");
const message = { id: "message", threadId: "thread", turnId: "turn", projectId: "project" };

function renderComparison(attributes: Record<string, string>) {
  return renderSlot(
    { component: SmartImageCompareDirective },
    {
      attributes,
      message,
      source: "::smart-image-compare{}",
      openWorkspaceFile: null,
    },
  );
}

test("resolves local images through the owning thread and preserves remote URLs", () => {
  expect(imageCompareUrl("screens/before #1.png", "thread", "workspace")).toBe(
    "/api/v1/threads/thread/worktree/files/screens/before%20%231.png",
  );
  expect(imageCompareUrl("after.png", "thread", "thread-storage")).toBe(
    "/api/v1/threads/thread/thread-storage/files/after.png",
  );
  expect(imageCompareUrl("https://example.com/image.png", "thread", "workspace")).toBe(
    "https://example.com/image.png",
  );
  for (const path of [
    "",
    "../secret.png",
    "/tmp/image.png",
    "javascript:alert(1)",
    "file:///tmp/a",
    "https://user:pass@example.com/a",
  ]) {
    expect(() => imageCompareUrl(path, "thread", "workspace")).toThrow();
  }
});

test("renders custom labels, accessible images, and reports dimension and load failures", () => {
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
  fireEvent.error(after);
  expect(view.getByText(/Could not load a comparison image/)).toBeDefined();
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
