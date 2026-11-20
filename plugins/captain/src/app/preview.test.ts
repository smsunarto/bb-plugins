import { expect, test } from "vitest";
import { previewLines } from "./preview.tsx";

const text = (markdown: string) =>
  previewLines(markdown).map((line) => ("text" in line ? line.text : ""));

test("inline code and autolinks keep their text; marks, links and tags keep only their label", () => {
  expect(text("Use `Array<T>` and read <https://example.com>.")).toEqual([
    "Use Array<T> and read https://example.com.",
  ]);
  expect(text("Mail <ops@example.com> or ``a ` b``")).toEqual(["Mail ops@example.com or a ` b"]);
  expect(text("**Bold** [docs](https://x.dev) ![shot](a.png) <b>tag</b> 1 < 2")).toEqual([
    "Bold docs shot tag 1 < 2",
  ]);
});

test("inline code inside a link's label keeps its text, and the link only its label", () => {
  expect(text("See [`getUser`](https://example.com/api).")).toEqual(["See getUser."]);
  expect(text("Call [`a<b>`](x) then ![`img`](y.png)")).toEqual(["Call a<b> then img"]);
});
