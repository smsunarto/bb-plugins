// @vitest-environment jsdom
import { describe, expect, test } from "vitest";
import { sizeSvg } from "./icon-image.ts";

const SVG = "http://www.w3.org/2000/svg";
const root = (text: string) =>
  new DOMParser().parseFromString(text, "image/svg+xml").documentElement;

describe("an uploaded SVG is sized before it is drawn", () => {
  test("a viewBox-only SVG gets a viewport the size of its whole drawing", () => {
    // The reviewer's fixture: without a size the browser drew a 300x150 crop and lost the circle.
    const sized = sizeSvg(
      `<svg xmlns="${SVG}" viewBox="0 0 10 10"><rect width="10" height="10" fill="orange"/><circle cx="5" cy="5" r="3" fill="blue"/></svg>`,
    );
    expect(sized).toMatchObject({ width: 192, height: 192 });
    const svg = root(sized?.text ?? "");
    expect(svg.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(svg.getAttribute("width")).toBe("192");
    expect(svg.getAttribute("height")).toBe("192");
    expect(svg.getElementsByTagName("circle")).toHaveLength(1);
  });

  test("a wide viewBox keeps its shape, with the shorter side at 192", () => {
    expect(sizeSvg(`<svg xmlns="${SVG}" viewBox="0 0 40 20"/>`)).toMatchObject({
      width: 384,
      height: 192,
    });
  });

  test("an SVG sized only by width and height gains a viewBox from them", () => {
    const sized = sizeSvg(`<svg xmlns="${SVG}" width="24px" height="48"/>`);
    expect(sized).toMatchObject({ width: 192, height: 384 });
    expect(root(sized?.text ?? "").getAttribute("viewBox")).toBe("0 0 24 48");
  });

  test("text that is not an SVG is refused", () => {
    expect(sizeSvg("<html><body/></html>")).toBeNull();
    expect(sizeSvg("not xml")).toBeNull();
  });
});
