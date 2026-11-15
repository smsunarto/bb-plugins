/**
 * The built stylesheet keeps out of Chrome's universal bucket, which bb
 * matches against every element on each thread switch and panel toggle. The
 * one allowed exception is the builder's Tailwind `@layer properties`
 * fallback, inside an `@supports` block Chrome evaluates false; a second
 * universal rule anywhere fails here.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transform, type Rule, type Selector } from "lightningcss";
import { beforeAll, expect, test } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
/** Tailwind's fallback for browsers without `@property`: old Safari and old Firefox. */
const FALLBACK_SUPPORTS =
  "(((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b))))";
/**
 * What a subject needs so the rule is keyed, not universal. An attribute alone
 * does not count: the budget treats it as universal, since not every engine
 * buckets by attribute.
 */
const KEYED = new Set(["type", "class", "id"]);
/** Subjects that match one element, the document root or a shadow host. */
const ROOT_ONLY = new Set(["root", "host"]);
/**
 * bb's icon root, which the vendored shadcn kit (coarse-pointer-sizing,
 * toggle) sizes as `[&_[data-icon-root]]:size-4`. Blink buckets it by
 * attribute name, and every such rule sits under a class-keyed control.
 */
const KEYED_ATTRIBUTES = new Set(["data-icon-root"]);

/** A one-part compound keyed by bb's icon root or an svg tag. */
const iconPart = (selector: Selector) =>
  selector.length === 1 &&
  ((selector[0]!.type === "type" && selector[0]!.name === "svg") ||
    (selector[0]!.type === "attribute" && KEYED_ATTRIBUTES.has(selector[0]!.name)));

/**
 * The shared Button's icon sizing in @bb-plugins/ui's controls.css, which
 * ends in `:is(svg, [data-icon-root])` and `:where(svg, [data-icon-root])`.
 * Known, and reported to that package; any other `:is` or `:where` subject fails.
 */
function sharedIconRule(parts: Selector): boolean {
  if (parts.length !== 1) return false;
  const [part] = parts;
  return (
    part!.type === "pseudo-class" &&
    (part!.kind === "is" || part!.kind === "where") &&
    part!.selectors.every(iconPart)
  );
}

type Found = { selector: string; within: string[] };

function subject(selector: Selector) {
  const last = selector.findLastIndex((part) => part.type === "combinator");
  return selector.slice(last + 1);
}

function universal(selector: Selector): boolean {
  const parts = subject(selector);
  if (parts.some((part) => KEYED.has(part.type))) return false;
  if (parts.some((part) => part.type === "attribute" && KEYED_ATTRIBUTES.has(part.name)))
    return false;
  if (sharedIconRule(parts)) return false;
  return !parts.some((part) => part.type === "pseudo-class" && ROOT_ONLY.has(part.kind));
}

let found: Found[] = [];

beforeAll(() => {
  execFileSync("bb", ["plugin", "build", "."], { cwd: ROOT, stdio: "pipe", timeout: 120_000 });
  const code = readFileSync(resolve(ROOT, "dist/app.css"));
  const rules: Rule[] = [];
  transform({
    filename: "app.css",
    code,
    visitor: {
      StyleSheet(sheet) {
        rules.push(...sheet.rules);
      },
    },
  });
  const condition = (rule: Rule): string => {
    if (rule.type === "supports") return `@supports ${rule.value.condition.type}`;
    if (rule.type === "layer-block") return `@layer ${rule.value.name?.join(".") ?? ""}`;
    return `@${rule.type}`;
  };
  const walk = (list: readonly Rule[], within: string[]) => {
    for (const rule of list) {
      if (rule.type === "style")
        for (const selector of rule.value.selectors)
          if (universal(selector)) found.push({ selector: JSON.stringify(selector), within });
      const inner =
        "value" in rule && rule.value && "rules" in rule.value ? rule.value.rules : null;
      if (Array.isArray(inner)) walk(inner as Rule[], [...within, condition(rule)]);
    }
  };
  found = [];
  walk(rules, []);
}, 120_000);

test("the only universal rule is Tailwind's @property fallback, behind @supports Chrome rejects", () => {
  expect(found.map((rule) => rule.within)).toEqual(
    found.map(() => ["@layer properties", "@supports or"]),
  );
  expect(found.map((rule) => JSON.parse(rule.selector)[0])).toEqual([
    { type: "universal" },
    { type: "pseudo-element", kind: "before" },
    { type: "pseudo-element", kind: "after" },
    { type: "pseudo-element", kind: "backdrop", vendorPrefix: [] },
  ]);
  const css = readFileSync(resolve(ROOT, "dist/app.css"), "utf8");
  expect(css.split("*,").length - 1).toBe(1);
  expect(css).toContain(`@supports ${FALLBACK_SUPPORTS}{*,:before,:after,::backdrop{`);
});

test("the built app has no unnamed plugin root, so bb serves it the narrow stylesheet", () => {
  // bb 0.49 drops the `[data-bb-plugin-root]:not([data-bb-plugin])` arm only
  // when every `data-bb-plugin-root` in app.js has a `data-bb-plugin` within
  // 120 characters; one unnamed root keeps the whole plugin on the wide sheet.
  const app = readFileSync(resolve(ROOT, "dist/app.js"), "utf8");
  const unnamed = [...app.matchAll(/data-bb-plugin-root/g)].filter(({ index }) => {
    const near = app.slice(Math.max(0, index - 120), index + 140);
    return !/data-bb-plugin(?!-)/.test(near);
  });
  expect(unnamed).toEqual([]);
});
