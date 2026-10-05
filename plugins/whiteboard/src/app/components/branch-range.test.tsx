// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewBranchRange } from "./branch-range.tsx";

const COMMIT = "77a83269abcdef0123456789abcdef0123456789";
const BASE = "aaaaaaaa11111111111111111111111111111111";
const HEAD = "bbbbbbbb22222222222222222222222222222222";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows one commit chip when base and head are the same commit", () => {
  const { container } = render(<ReviewBranchRange baseRef={COMMIT} headRef={COMMIT} />);

  expect(screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
    "Copy session commit hash 77a83269abcdef0123456789abcdef0123456789",
  ]);
  expect(container.textContent).toBe("77a83269");
  expect(screen.getByRole("button").title).toBe(`commit ${COMMIT}\nClick to copy`);
});

it("copies the full hash from the single chip", async () => {
  const writeText = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  render(<ReviewBranchRange baseRef={COMMIT} headRef={COMMIT} />);

  await act(async () => {
    fireEvent.click(screen.getByRole("button"));
  });

  expect(writeText).toHaveBeenCalledWith(COMMIT);
  expect(screen.getByRole("status").textContent).toBe("Copied");
});

it("keeps upstream's base ← head range when the commits differ", () => {
  render(<ReviewBranchRange baseRef={BASE} headRef={HEAD} />);

  const range = screen.getByRole("group", {
    name: "Session commits: base aaaaaaaa, head bbbbbbbb",
  });
  expect(range.textContent).toBe("aaaaaaaa←bbbbbbbb");
  expect(screen.getAllByRole("button")).toHaveLength(2);
});
