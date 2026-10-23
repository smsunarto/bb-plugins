import { previewSurfaceClass } from "./surfaces";
import { expect } from "storybook/test";

/** Runs after every story, including stories with their own interaction checks. */
export function assertMonokai({
  canvasElement,
  title,
}: {
  canvasElement: HTMLElement;
  title: string;
}) {
  const scope = previewSurfaceClass(title);
  if (scope) expect(canvasElement.querySelector(`.${scope}`)).not.toBeNull();
  const document = canvasElement.ownerDocument;
  const root = getComputedStyle(document.documentElement);
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(root.colorScheme).toBe("dark");
  expect(root.getPropertyValue("--background").trim()).toBe("#151515");
  expect(root.getPropertyValue("--foreground").trim()).toBe("#e3e3dd");
  expect(root.getPropertyValue("--primary").trim()).toBe("#88c0d0");
  for (const surface of [
    canvasElement,
    ...document.querySelectorAll(
      '[role="dialog"], .review-canvas-root[data-review-theme], diffs-container',
    ),
  ]) {
    const style = getComputedStyle(surface);
    expect(style.getPropertyValue("--foreground").trim()).toBe(
      root.getPropertyValue("--foreground").trim(),
    );
    expect(style.colorScheme).toBe("dark");
    if (surface.matches("diffs-container")) {
      expect(style.getPropertyValue("--diffs-bg-context-override").trim()).toBe(
        root.getPropertyValue("--diffs-bg-context-override").trim(),
      );
    }
  }
}
