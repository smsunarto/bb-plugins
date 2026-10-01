import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The CSS token report (design §3.8, WP4): every literal color the vendored
 * sheets declare as a token resolves to a bb token in `tokens.css`.
 */
const APP = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(APP, file), "utf8");

const VENDORED_SHEETS = [
  "vendor/review/app/src/styles.css",
  "vendor/review/app/src/whiteboard.css",
  "vendor/review/app/src/api-document.css",
  "vendor/review/app/src/flow-diagram.css",
  "vendor/review/app/src/authoring-activity.css",
  "vendor/review/app/src/software-map/styles.css",
  "vendor/npm/@xyflow/react/dist/style.css",
];

/** bb theme tokens (bb `apps/app/src/components/ui/theme.css`, both themes; monokai pins `.dark`). */
const BB_TOKENS = new Set([
  "--background",
  "--foreground",
  "--popover",
  "--popover-foreground",
  "--secondary",
  "--accent",
  "--muted-foreground",
  "--subtle-foreground",
  "--border",
  "--timeline-accent",
  "--state-hover",
  "--state-active",
  "--surface-raised",
  "--surface-recessed",
  "--surface-scrim",
  "--attention",
  "--warning",
  "--warning-text",
  "--success",
  "--destructive-text",
  "--pr-merged",
  "--font-mono",
  // Collisions, readable only because tokens.css resets them to `inherit`.
  "--diff-added",
  "--diff-removed",
  "--shadow-color",
]);

/** Upstream names that are also bb tokens. Overriding them must not self-reference. */
const COLLISIONS = ["--diff-added", "--diff-removed", "--shadow-color", "--font-serif"];

/** Literal colors left in vendored rules, each with the reason it is acceptable. */
const ALLOWED_RULE_LITERALS = [
  {
    selector: /mask-image|^(from|to)$|data-motion|data-collapsed/,
    reason: "masks read alpha only",
  },
  { selector: /react-flow__attribution/, reason: "attribution hidden (proOptions)" },
  { selector: /react-flow__edge\.updating/, reason: "edges are not reconnectable" },
  { selector: /react-flow__resize-control/, reason: "no NodeResizer in the canvas" },
];

/** Tokens whose literal color sits inside an SVG data URI (no CSS variable can reach it). */
const DATA_URI_TOKENS = new Set(["--chevron-down", "--check-mark", "--board-grid"]);

const LITERAL =
  /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(|(?<![\w-])(?:white|black|red|green|blue|yellow|orange|purple|gr[ae]y|silver|navy)(?![\w-])/i;

type Declaration = { sheet: string; selector: string; property: string; value: string };

function declarations(sheet: string): Declaration[] {
  const css = read(sheet);
  const out: Declaration[] = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of body.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, " ");
    for (const part of match[2]!.split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      out.push({
        sheet,
        selector,
        property: part.slice(0, colon).trim(),
        value: part
          .slice(colon + 1)
          .trim()
          .replace(/\s+/g, " "),
      });
    }
  }
  return out;
}

/** The value with every `var(--vscode-x, fallback)` collapsed when tokens.css defines `--vscode-x`. */
function withoutBridgedFallbacks(value: string, defined: Set<string>): string {
  let previous: string;
  let next = value;
  do {
    previous = next;
    next = next.replace(
      /var\(\s*(--[\w-]+)\s*,((?:[^()]|\([^()]*\))*)\)/g,
      (whole, name: string) => (defined.has(name) ? `var(${name})` : whole),
    );
  } while (next !== previous);
  return next;
}

/** xyflow reads `--xy-x` before its literal `--xy-x-default`; every other token overrides itself. */
function overriddenBy(property: string): string {
  return property
    .replace(/^--xy-background-pattern-\w+-color-default$/, "--xy-background-pattern-color")
    .replace(/^(--xy-.+)-default$/, "$1");
}

const tokens = declarations("styles/tokens.css");
const defined = new Set(
  tokens.filter((entry) => entry.property.startsWith("--")).map((entry) => entry.property),
);
const vendored = VENDORED_SHEETS.flatMap(declarations);
/** Workbench variables upstream itself pins to `transparent` on the canvas. */
const pinned = new Set(
  vendored
    .filter((entry) => entry.property.startsWith("--vscode-") && entry.value === "transparent")
    .map((entry) => entry.property),
);
const resolvable = new Set([...defined, ...pinned]);

describe("tokens.css", () => {
  it("maps every literal-color token of the vendored sheets", () => {
    const unmapped = vendored
      .filter((entry) => entry.property.startsWith("--"))
      .filter((entry) => !DATA_URI_TOKENS.has(entry.property))
      .filter((entry) => LITERAL.test(withoutBridgedFallbacks(entry.value, resolvable)))
      .filter((entry) => !defined.has(overriddenBy(entry.property)))
      .map((entry) => `${entry.sheet} ${entry.selector} ${entry.property}`);
    expect(unmapped).toEqual([]);
  });

  it("defines every --vscode-* variable the canvas reads", () => {
    const sources = VENDORED_SHEETS.map(read).join("\n");
    const reads = new Set(sources.match(/var\(\s*--vscode-[\w-]+/g)?.map((m) => m.slice(4).trim()));
    const missing = [...reads].filter((name) => !defined.has(name) && !pinned.has(name)).sort();
    expect(missing).toEqual([]);
  });

  it("uses only bb tokens, color-mix and transparent", () => {
    const offending = tokens.filter((entry) => {
      if (LITERAL.test(entry.value)) return true;
      const refs = [...entry.value.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!);
      return refs.some((name) => !BB_TOKENS.has(name));
    });
    expect(offending).toEqual([]);
  });

  it("resets colliding names to bb's value instead of self-referencing", () => {
    for (const name of COLLISIONS) {
      const values = tokens.filter((entry) => entry.property === name).map((entry) => entry.value);
      expect(values).toEqual(["inherit"]);
    }
  });

  it("overrides every literal color in vendored rules or allowlists it", () => {
    const overridden = new Set(tokens.map((entry) => `${entry.property}|${entry.selector}`));
    const unhandled = vendored
      .filter((entry) => !entry.property.startsWith("--"))
      .filter((entry) => LITERAL.test(withoutBridgedFallbacks(entry.value, resolvable)))
      .filter(
        (entry) =>
          !ALLOWED_RULE_LITERALS.some(
            (allowed) =>
              allowed.selector.test(entry.selector) || allowed.selector.test(entry.property),
          ),
      )
      .filter(
        (entry) =>
          ![...overridden].some(
            (key) =>
              key.startsWith(`${entry.property}|`) &&
              entry.selector.split(",").every((part) => key.includes(part.trim())),
          ),
      )
      .map((entry) => `${entry.sheet} ${entry.selector} ${entry.property}: ${entry.value}`);
    expect(unhandled).toEqual([]);
  });
});
