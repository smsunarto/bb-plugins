import { expect, spyOn, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import { mountHairlineDensity } from "../app/hairline-density.ts";

test("tracks the display's device pixel and clears it on abort", () => {
  installDom();
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const view = frame.contentWindow!;
  const doc = view.document;
  let scale = 2.5;
  Object.defineProperty(view, "devicePixelRatio", { get: () => scale });
  const queries: EventTarget[] = [];
  Object.defineProperty(view, "matchMedia", {
    value: () => {
      const query = new window.EventTarget();
      queries.push(query);
      return query;
    },
  });
  const media = spyOn(view, "matchMedia");
  const controller = new window.AbortController();
  const read = () => doc.documentElement.style.getPropertyValue("--monokai-device-pixel");
  const dispose = mountHairlineDensity({ document: doc, signal: controller.signal });
  try {
    expect(read()).toBe("0.4px");
    expect(media).toHaveBeenLastCalledWith("(resolution: 2.5dppx)");
    scale = 1.5;
    queries[0]?.dispatchEvent(new window.Event("change"));
    expect(Number.parseFloat(read()) * scale).toBeCloseTo(1, 10);
    expect(media).toHaveBeenLastCalledWith("(resolution: 1.5dppx)");
    queries[0]?.dispatchEvent(new window.Event("change"));
    expect(media).toHaveBeenCalledTimes(2);
    controller.abort();
    expect(read()).toBe("");
    queries[1]?.dispatchEvent(new window.Event("change"));
    expect(media).toHaveBeenCalledTimes(2);
  } finally {
    dispose?.();
    frame.remove();
  }
});
