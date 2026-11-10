/**
 * The committed page bundle is built from the current sources. Run
 * `bun run build:page` after changing any file the page bundles.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";
import { PAGE_SOURCE_HASH, PAGE_SOURCES } from "../../../generated/page-bundle.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

test("the committed page bundle matches the sources it was built from", () => {
  const hash = createHash("sha256");
  for (const path of [...PAGE_SOURCES].sort())
    hash.update(`${path}\0${readFileSync(resolve(ROOT, path), "utf8")}\0`);
  expect(hash.digest("hex"), "run `bun run build:page`").toBe(PAGE_SOURCE_HASH);
});

test("every page module is in the bundle", () => {
  const page = readdirSync(resolve(ROOT, "src/app/page"))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => `src/app/page/${name}`);
  expect(PAGE_SOURCES).toEqual(expect.arrayContaining(page));
});
