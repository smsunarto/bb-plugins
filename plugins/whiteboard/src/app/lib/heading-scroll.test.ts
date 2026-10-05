// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scrollToReviewHeading } from "./heading-scroll.ts";

let frames: FrameRequestCallback[] = [];
const flushFrame = () => frames.splice(0).forEach((callback) => callback(0));

beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mount(heading: string) {
  document.body.innerHTML = `<button id="contents-link">2 Design</button><section id="region"><article>${heading}<p>Body</p></article></section>`;
  const region = document.getElementById("region")!;
  const scrollTo = vi.fn();
  region.scrollTo = scrollTo;
  document.getElementById("contents-link")!.focus();
  return { article: region.querySelector("article")!, region, scrollTo };
}

it("scrolls to the heading, then focuses it two frames later", () => {
  const { article, region, scrollTo } = mount(`<h2 id="design">Design</h2>`);

  scrollToReviewHeading("design", article, region);
  expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
  flushFrame();
  expect(document.activeElement?.id).toBe("contents-link");
  flushFrame();

  expect(document.activeElement?.id).toBe("design");
  expect(document.getElementById("design")?.getAttribute("tabindex")).toBe("-1");
});

it("keeps a heading's own tabindex", () => {
  const { article, region } = mount(`<h2 id="design" tabindex="0">Design</h2>`);

  scrollToReviewHeading("design", article, region);
  flushFrame();
  flushFrame();

  expect(document.activeElement?.id).toBe("design");
  expect(document.getElementById("design")?.getAttribute("tabindex")).toBe("0");
});
