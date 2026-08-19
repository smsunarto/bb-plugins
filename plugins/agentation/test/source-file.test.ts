import assert from "node:assert/strict";
import test from "node:test";

import type { Annotation } from "../lib/afs.ts";
import { usableSourceFile, withoutBundleSource } from "../lib/annotation-hygiene.ts";

function annotation(sourceFile?: string): Annotation {
  return {
    id: "ann_1",
    comment: "…",
    elementPath: "body > button",
    timestamp: 1,
    x: 0,
    y: 0,
    element: "button",
    ...(sourceFile === undefined ? {} : { sourceFile }),
  } as Annotation;
}

test("a served bundle path is not a source location", () => {
  // Exactly what bb's production build reported for a plugin-drawn button.
  assert.equal(usableSourceFile("api/v1/plugins/agentation/assets/app.js:10771:17"), false);
  assert.equal(usableSourceFile("/assets/index-a1b2c3.js:42:8"), false);
  assert.equal(usableSourceFile("http://127.0.0.1:38886/app.js:1:1"), false);
});

test("a repository path survives", () => {
  assert.equal(usableSourceFile("components/annotation-panel.tsx:120:5"), true);
  assert.equal(usableSourceFile("src/app/page.tsx"), true);
});

test("a missing source file is simply absent", () => {
  assert.equal(usableSourceFile(undefined), false);
  assert.equal(usableSourceFile(""), false);
});

test("a bundle source is dropped rather than sent to the agent", () => {
  const cleaned = withoutBundleSource(
    annotation("api/v1/plugins/agentation/assets/app.js:10771:17"),
  );
  assert.equal("sourceFile" in cleaned, false);
});

test("a real source path is left alone", () => {
  const original = annotation("app.tsx:12:3");
  assert.equal(withoutBundleSource(original), original);
});
