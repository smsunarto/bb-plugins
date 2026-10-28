import { describe, expect, it } from "vitest";
import type { UiNode } from "../../core/types";
import { hotspotPoints, imageRef, inlineFacts, parseUrl, percent, sourceLinks } from "./references-model";

const node: UiNode = { kind: "node", type: "Badge", key: "b", props: { text: "new" } };

describe("parseUrl", () => {
  it("accepts only the given schemes, with a host", () => {
    expect(parseUrl(" https://example.com/a ", ["https"])?.href).toBe("https://example.com/a");
    expect(parseUrl("http://example.com", ["https"])).toBeNull();
    expect(parseUrl("http://example.com", ["http", "https"])?.href).toBe("http://example.com/");
    expect(parseUrl("javascript:alert(1)", ["https"])).toBeNull();
    expect(parseUrl("example.com", ["https"])).toBeNull();
    expect(parseUrl("", ["https"])).toBeNull();
  });
});

describe("imageRef", () => {
  it("loads https URLs and thread files, refuses other schemes", () => {
    expect(imageRef("")).toEqual({ kind: "none" });
    expect(imageRef("images/bike.svg")).toEqual({ kind: "load", src: "images/bike.svg" });
    expect(imageRef("$BB_THREAD_STORAGE/shot.png")).toEqual({ kind: "load", src: "$BB_THREAD_STORAGE/shot.png" });
    expect(imageRef("C:\\shots\\a.png")).toEqual({ kind: "load", src: "C:\\shots\\a.png" });
    expect(imageRef("https://cdn.example.com/a b.png")).toEqual({ kind: "load", src: "https://cdn.example.com/a%20b.png" });
    expect(imageRef("http://example.com/a.png").kind).toBe("invalid");
    expect(imageRef("data:image/png;base64,AAAA").kind).toBe("invalid");
  });
});

describe("inlineFacts", () => {
  it("takes the first plain, non-empty values up to the limit", () => {
    expect(
      inlineFacts(
        [
          ["Status", node],
          ["Price", "$39"],
          ["Empty", " "],
          ["Rating", 4.6],
          ["In stock", true],
          ["Weight", "320 g"],
        ],
        3,
      ),
    ).toEqual([
      { label: "Price", value: "$39" },
      { label: "Rating", value: "4.6" },
      { label: "In stock", value: "true" },
    ]);
  });
});

describe("sourceLinks", () => {
  it("reads URLs and objects, defaulting the title to the domain and showing the path then", () => {
    expect(
      sourceLinks([
        "https://www.example.com/docs/getting%20started/",
        { url: "https://news.example.org/a", title: "Launch post", note: "the announcement" },
      ]),
    ).toEqual([
      {
        ok: true,
        number: 1,
        href: "https://www.example.com/docs/getting%20started/",
        title: "example.com",
        domain: "example.com",
        path: "docs/getting started",
        note: null,
      },
      {
        ok: true,
        number: 2,
        href: "https://news.example.org/a",
        title: "Launch post",
        domain: "news.example.org",
        path: null,
        note: "the announcement",
      },
    ]);
  });

  it("keeps each link's number when an earlier one is refused", () => {
    const links = sourceLinks(["http://plain.example.com", 42, { title: "no url" }, "https://ok.example.com"]);
    expect(links.map((link) => [link.number, link.ok])).toEqual([
      [1, false],
      [2, false],
      [3, false],
      [4, true],
    ]);
    expect(links[0]).toMatchObject({ error: "Not an https link: http://plain.example.com" });
    expect(links[2]).toMatchObject({ error: "This source has no url" });
  });

  it("skips a last object that has not reached its url yet", () => {
    expect(sourceLinks(["https://a.example.com", { title: "Still stream" }])).toHaveLength(1);
  });
});

describe("percent", () => {
  it("reads numbers and percent strings, clamped to 0–100", () => {
    expect(percent(42.5)).toBe(42.5);
    expect(percent("40%")).toBe(40);
    expect(percent(" 7 ")).toBe(7);
    expect(percent(140)).toBe(100);
    expect(percent(-3)).toBe(0);
    expect(percent("left")).toBeNull();
    expect(percent(null)).toBeNull();
  });
});

describe("hotspotPoints", () => {
  it("numbers good points in order and reports the unreadable ones", () => {
    const { points, problems } = hotspotPoints([
      { x: 10, y: "20%", title: "Saddle", text: "Height matters" },
      { x: "left", y: 5, title: "Bell" },
      "Chain",
      { x: 80, y: 120, title: "" },
      { x: 50, y: 50, title: "Pedals" },
    ]);
    expect(points).toEqual([
      { number: 1, x: 10, y: 20, title: "Saddle", text: "Height matters" },
      { number: 2, x: 80, y: 100, title: "Point 2", text: null },
      { number: 3, x: 50, y: 50, title: "Pedals", text: null },
    ]);
    expect(problems).toEqual(["Point 2 (Bell) needs x and y in % (0–100)", "Point 3 must be {x, y, title, text?}"]);
  });

  it("skips a last point that is still streaming", () => {
    expect(hotspotPoints([{ x: 1, y: 2, title: "A" }, { x: 30 }])).toEqual({
      points: [{ number: 1, x: 1, y: 2, title: "A", text: null }],
      problems: [],
    });
    expect(hotspotPoints([{ x: 1, y: 2, title: "A" }, { x: 30, y: 40 }]).points).toHaveLength(1);
  });
});
