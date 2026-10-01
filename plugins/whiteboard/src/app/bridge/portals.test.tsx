// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PortalHost, createPortals } from "./portals.tsx";

afterEach(cleanup);

describe("portals", () => {
  it("renders entries into containers it does not own, and updates and removes them", () => {
    const portals = createPortals();
    const container = document.createElement("div");
    document.body.appendChild(container);
    render(<PortalHost portals={portals} />);

    let remove!: () => void;
    act(() => {
      remove = portals.mount({ id: "editor-1", container, element: <span>first</span> });
    });
    expect(container.textContent).toBe("first");

    act(() => portals.update("editor-1", <span>second</span>));
    expect(container.textContent).toBe("second");

    act(() => remove());
    expect(container.textContent).toBe("");
    container.remove();
  });

  it("replaces an entry with the same id, and a stale removal leaves the replacement", () => {
    const portals = createPortals();
    const first = document.createElement("div");
    const second = document.createElement("div");
    render(<PortalHost portals={portals} />);

    let removeFirst!: () => void;
    act(() => {
      removeFirst = portals.mount({ id: "tooltip", container: first, element: "a" });
      portals.mount({ id: "tooltip", container: second, element: "b" });
    });
    expect(first.textContent).toBe("");
    expect(second.textContent).toBe("b");

    act(() => removeFirst());
    expect(second.textContent).toBe("b");
  });

  it("ignores updates for unknown ids", () => {
    const portals = createPortals();
    render(<PortalHost portals={portals} />);
    expect(() => act(() => portals.update("missing", "x"))).not.toThrow();
  });
});
