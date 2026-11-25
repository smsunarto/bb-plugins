import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { installDom } from "@bb-plugins/testing";

// The theme's hairline rules restyle Tailwind's border utilities, which bb and
// the plugins load in any order. This resolves the cascade for one property of
// a fixture element: the theme plus a minimal Tailwind utilities sheet, in both
// load orders, with each rule's layer, specificity, source order, and media or
// container condition. jsdom only matches selectors; the rest is computed here.
const theme = await readFile(
  process.env["HAIRLINE_THEME"] ?? new URL("../themes/bb-monokai.css", import.meta.url),
  "utf8",
);

// The Tailwind v4 utilities the fixtures carry, as bb and the plugins ship them.
const tailwind = `
@layer utilities {
  .border { border-width: 1px; }
  .border-0 { border-width: 0px; }
  .border-t-0 { border-top-width: 0px; }
  .border-b { border-bottom-width: 1px; }
  .not-first\\:border-t:not(:first-child) { border-top-width: 1px; }
  .first\\:border-l:first-child { border-left-width: 1px; }
  .\\[\\&\\>li\\+li\\]\\:border-t > li + li { border-top-width: 1px; }
  .divide-y > :not(:last-child) { border-block-end-width: 1px; }
  .border-b-0 { border-bottom-width: 0px; }
  .border-t-\\[0\\.5px\\] { border-top-width: 0.5px; }
  .h-px { height: 1px; }
  .bg-border { background-color: var(--border); }
  .data-\\[dragging\\]\\:bg-ring\\/40[data-dragging] { background-color: ring-40; }
  @container plugin-detail (width >= 28rem) {
    .\\@min-\\[28rem\\]\\/plugin-detail\\:border-b-0 { border-bottom-width: 0px; }
  }
}`;

type Rule = { selector: string; atRules: string[]; body: string; sheet: number; order: number };
type Context = { dppx: number; container: number };

function styleRules(css: string, sheet: number): Rule[] {
  const rules: Rule[] = [];
  const open: string[] = [];
  for (const [, text = "", brace] of css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]*)([{}])/g)) {
    if (brace === "{") {
      // Drop statements such as `@layer a, b;` that precede the block.
      open.push(
        text
          .slice(text.lastIndexOf(";") + 1)
          .trim()
          .replace(/\s+/g, " "),
      );
      continue;
    }
    const selector = open.pop() ?? "";
    if (!selector.startsWith("@")) {
      rules.push({ selector, atRules: [...open], body: text, sheet, order: rules.length });
    }
  }
  return rules;
}

/** Selector specificity as [ids, classes, types]; :where adds nothing. */
function specificity(selector: string): [number, number, number] {
  let rest = selector;
  const total: [number, number, number] = [0, 0, 0];
  const add = (s: [number, number, number]) => {
    total[0] += s[0];
    total[1] += s[1];
    total[2] += s[2];
  };
  // Functional pseudo-classes, innermost first.
  for (;;) {
    const match = /:(where|is|not)\(([^()]*)\)/.exec(rest);
    if (!match) break;
    if (match[1] !== "where") {
      const parts = (match[2] ?? "").split(",").map((part) => specificity(part.trim()));
      add(parts.reduce((max, s) => (compare(s, max) > 0 ? s : max), [0, 0, 0]));
    }
    rest = rest.slice(0, match.index) + " " + rest.slice(match.index + match[0].length);
  }
  rest = rest.replace(/\\./g, "_");
  add([
    (rest.match(/#[\w-]+/g) ?? []).length,
    (rest.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length,
    (rest.match(/(^|[\s>+~])[a-z][\w-]*/gi) ?? []).length + (rest.match(/::[\w-]+/g) ?? []).length,
  ]);
  return total;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function applies(atRules: string[], context: Context): boolean {
  return atRules.every((at) => {
    if (at.startsWith("@layer")) return true;
    const min = /min-resolution:\s*([\d.]+)dppx/.exec(at);
    if (min) return context.dppx >= Number(min[1]);
    const below = /resolution\s*<\s*([\d.]+)dppx/.exec(at);
    if (below) return context.dppx < Number(below[1]);
    const container = /@container plugin-detail \(width\s*>=\s*([\d.]+)rem\)/.exec(at);
    if (container) return context.container >= Number(container[1]) * 16;
    return false;
  });
}

const LONGHANDS: Record<string, string[]> = {
  "border-top-width": [
    "border-top-width",
    "border-width",
    "border-block-width",
    "border-top",
    "border",
  ],
  "border-bottom-width": [
    "border-bottom-width",
    "border-width",
    "border-block-width",
    "border-bottom",
    "border",
  ],
  "box-shadow": ["box-shadow"],
  "--monokai-edge": ["--monokai-edge"],
  "border-block-end-width": ["border-block-end-width"],
  "border-left-width": ["border-left-width", "border-width"],
  height: ["height"],
  "background-color": ["background-color", "background"],
};

// Only split top-level commas. A ring predicate can nest selector lists
// inside :is() and :not(), and escaped commas can be part of a utility name.
function selectorList(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < selector.length; index++) {
    const char = selector[index];
    if (char === "\\") index++;
    else if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if (char === "," && depth === 0) {
      parts.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}

type Key = [number, number, number, number, number, number];

/** Each declaration of `property` that reaches `node`, keyed by cascade rank. */
function candidates(
  node: Element,
  property: keyof typeof LONGHANDS,
  context: Context,
  rule: Rule,
): Array<{ value: string; key: Key }> {
  if (!applies(rule.atRules, context)) return [];
  const parts = selectorList(rule.selector).filter((part) => {
    try {
      return node.matches(part);
    } catch {
      return false;
    }
  });
  if (parts.length === 0) return [];
  const spec = parts
    .map((part) => specificity(part.trim()))
    .reduce((max, s) => (compare(s, max) > 0 ? s : max));
  const layered = rule.atRules.some((at) => at.startsWith("@layer")) ? 0 : 1;
  const key: Key = [layered, ...spec, rule.sheet, rule.order];
  return [...rule.body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)]
    .filter(([, name = ""]) => LONGHANDS[property]?.includes(name.trim()))
    .map(([, , value = ""]) => ({ value: value.trim(), key }));
}

/** The winning declaration for `property`, or undefined when no rule sets it. */
function resolve(
  node: Element,
  property: keyof typeof LONGHANDS,
  context: Context,
  tailwindFirst: boolean,
): string | undefined {
  const sheets = tailwindFirst ? [tailwind, theme] : [theme, tailwind];
  const all = sheets.flatMap((css, sheet) =>
    styleRules(css, sheet).flatMap((rule) => candidates(node, property, context, rule)),
  );
  const rank = (a: Key, b: Key) => a.reduce((cmp, n, i) => cmp || n - (b[i] ?? 0), 0);
  return all.reduce<{ value: string; key: Key } | undefined>(
    (best, next) => (!best || rank(next.key, best.key) >= 0 ? next : best),
    undefined,
  )?.value;
}

installDom();
document.documentElement.classList.add("dark");

function element(tag: string, className: string, attributes: Record<string, string> = {}) {
  const node = document.createElement(tag);
  node.className = className;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  document.body.append(node);
  return node;
}

/** The value in both load orders; they must agree. */
function cascade(node: Element, property: keyof typeof LONGHANDS, context: Context) {
  const first = resolve(node, property, context, true);
  expect(resolve(node, property, context, false)).toBe(first);
  return first;
}

const AT_1X = { dppx: 1, container: 0 };
const AT_2X = { dppx: 2, container: 0 };
const AT_3X = { dppx: 3, container: 0 };
const RING = /inset 0 0 0 var\(--hairline-ring-width\) var\(--monokai-edge\)/;
// bb's Input, verbatim from bb 0.49's bundle.
const BB_INPUT =
  "flex w-full rounded-md border border-input bg-transparent pl-3 pr-3 py-1 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

describe("bb Monokai hairline cascade", () => {
  test("keeps every hairline border at least two device pixels at 3x and a whole pixel at 1x", () => {
    // WebKit paints a one-device-pixel border at zero width on a half device pixel.
    const width = (context: Context) => {
      let px = /--hairline-width:\s*0\.5px;/.test(theme) ? 0.5 : NaN;
      for (const rule of styleRules(theme, 0)) {
        const set = /--hairline-width:\s*([^;]+);/.exec(rule.body)?.[1];
        if (rule.selector !== "html.dark" || !set || !applies(rule.atRules, context)) continue;
        px = Function(`return ${set.replace(/calc|px/g, "")}`)() as number;
      }
      return px * context.dppx;
    };
    expect(width(AT_1X)).toBeGreaterThanOrEqual(1);
    expect(width(AT_2X)).toBeGreaterThanOrEqual(1);
    expect(width(AT_3X)).toBeGreaterThanOrEqual(2);
  });

  test("draws a hairline border, not Tailwind's 1px, in either load order", () => {
    const box = element("div", "rounded-lg border border-border");
    expect(cascade(box, "border-top-width", AT_2X)).toBe("var(--hairline-width)");
    expect(cascade(box, "border-top-width", AT_3X)).toBe("var(--hairline-width)");
  });

  test("rings controls at 3x, not surfaces that restyle their own edges", () => {
    const radio = element("button", "aspect-square size-4 rounded-full border border-primary", {
      role: "radio",
    });
    const checkbox = element(
      "button",
      "size-4 rounded-sm border border-input data-[state=checked]:border-foreground",
      { role: "checkbox", "data-state": "checked" },
    );
    const field = element("input", BB_INPUT);
    const select = element("button", "h-7 w-full justify-between border border-border/60 bg-card");
    for (const control of [radio, checkbox, field, select]) {
      expect(cascade(control, "box-shadow", AT_3X) ?? "", control.outerHTML).toMatch(RING);
      expect(cascade(control, "border-top-width", AT_3X)).toBe("0");
      expect(cascade(control, "box-shadow", AT_2X) ?? "").not.toMatch(RING);
    }

    // Markdown tables, code blocks, the user bubble, toasts, and sheets restyle
    // their edges in rules a utility-class ring would draw over.
    for (const [tag, className] of [
      ["td", "border border-border px-3"],
      ["div", "overflow-hidden rounded-lg border border-border"],
      ["div", "rounded-2xl border border-border-seam bg-muted"],
    ] as const) {
      const surface = element(tag, className);
      expect(cascade(surface, "box-shadow", AT_3X) ?? "").not.toMatch(RING);
      expect(cascade(surface, "border-top-width", AT_3X)).toBe("var(--hairline-width)");
    }
  });

  test("rings only uniform controls and keeps settings triggers on the input edge", () => {
    for (const [tag, className, attributes] of [
      ["button", "cursor-zoom-in border border-border", {}],
      ["div", "rounded-md border border-border", { role: "radio" }],
      ["button", "rounded-lg border border-border", { role: "radio" }],
      ["input", `${BB_INPUT} border-dashed`, {}],
      ["input", `${BB_INPUT} border-t-0`, {}],
      ["button", "border border-border hover:border-primary", {}],
    ] as const) {
      const control = element(tag, className, attributes);
      expect(cascade(control, "box-shadow", AT_3X) ?? "", control.outerHTML).not.toMatch(RING);
    }
    const trigger = element("button", "border border-border/60 bg-card");
    expect(cascade(trigger, "--monokai-edge", AT_3X)).toBe("var(--input)");
  });

  test("sizes positional and child divider utilities in either load order", () => {
    const group = element("ul", "divide-y [&>li+li]:border-t");
    const first = element("li", "first:border-l not-first:border-t");
    const second = element("li", "not-first:border-t");
    group.append(first, second);
    expect(cascade(first, "border-left-width", AT_3X)).toBe("var(--hairline-width)");
    expect(cascade(first, "border-top-width", AT_3X)).toBeUndefined();
    expect(cascade(second, "border-top-width", AT_3X)).toBe("var(--hairline-width)");
    second.className = "";
    expect(cascade(second, "border-top-width", AT_3X)).toBe("var(--hairline-width)");
    expect(cascade(first, "border-block-end-width", AT_3X)).toContain("var(--hairline-width)");
    expect(cascade(second, "border-block-end-width", AT_3X)).toBeUndefined();
  });

  test("keeps a box's own widths and a hairline box's open side", () => {
    // gtd-sidebar's phone sheet separator.
    const separator = element(
      "div",
      "my-1 h-0 border-0 border-t-[0.5px] border-solid border-border",
    );
    expect(cascade(separator, "border-top-width", AT_2X)).toBe("0.5px");
    const open = element("div", "border border-t-0 border-border");
    expect(cascade(open, "border-top-width", AT_2X)).toBe("0");
    expect(cascade(open, "border-bottom-width", AT_2X)).toBe("var(--hairline-width)");
  });

  test("restates bb's container zero width over the hairline", () => {
    // Settings > Plugins > Capabilities: the name cell's rule ends at 28rem.
    const cell = element("th", "border-b border-border @min-[28rem]/plugin-detail:border-b-0");
    expect(cascade(cell, "border-bottom-width", { dppx: 2, container: 600 })).toBe("0");
    expect(cascade(cell, "border-bottom-width", { dppx: 2, container: 300 })).toBe(
      "var(--hairline-width)",
    );
  });

  test("sizes a 1px rule box as a hairline and leaves its state fills", () => {
    // bb's file-tree and split-pane splitters.
    const splitter = element("div", "h-px bg-border data-[dragging]:bg-ring/40");
    expect(cascade(splitter, "height", AT_3X)).toBe("var(--hairline-width)");
    expect(cascade(splitter, "background-color", AT_3X)).toBe("var(--border)");
    splitter.setAttribute("data-dragging", "");
    expect(cascade(splitter, "background-color", AT_3X)).toBe("ring-40");
  });
});
