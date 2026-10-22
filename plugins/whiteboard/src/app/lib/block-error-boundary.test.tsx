// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BlockErrorBoundary, type StoredBlock } from "../vendor/review/app/src/blocks.tsx";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("recovers a corrected block with the same id without retrying an unrelated render", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const onError = vi.fn();
  const broken: StoredBlock = { id: "block", type: "markdown", markdown: "broken" };
  function Content({ block }: { block: StoredBlock }) {
    if (block === broken) throw new Error("broken content");
    return <p>Corrected content</p>;
  }
  const view = (block: StoredBlock) => (
    <BlockErrorBoundary block={block} onError={onError}>
      <Content block={block} />
    </BlockErrorBoundary>
  );
  const { rerender } = render(view(broken));
  expect(screen.getByRole("alert").textContent).toContain("broken content");
  expect(onError).toHaveBeenCalledTimes(1);

  rerender(view(broken));
  expect(onError).toHaveBeenCalledTimes(1);

  rerender(view({ ...broken, markdown: "corrected" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Corrected content")).toBeTruthy();
});
