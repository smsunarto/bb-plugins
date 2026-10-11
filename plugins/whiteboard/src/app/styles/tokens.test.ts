import { readdirSync, readFileSync } from "node:fs";
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

/** bb theme tokens (bb `apps/app/src/components/ui/theme.css`). The canvas reads bb's `.light` scope. */
const BB_TOKENS = new Set([
  "--background",
  "--foreground",
  "--popover",
  "--popover-foreground",
  "--secondary",
  "--accent",
  "--muted-foreground",
  "--readback-foreground",
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
  "--font-sans",
  "--font-mono",
  // Collisions, readable only because tokens.css resets them to `inherit`.
  "--diff-added",
  "--diff-removed",
  "--shadow-color",
]);

/** Upstream names that are also bb tokens, with the value that avoids a self-reference. */
const COLLISIONS = {
  "--diff-added": "inherit",
  "--diff-removed": "inherit",
  "--shadow-color": "inherit",
  // bb sets prose in its sans face, not upstream's serif.
  "--font-serif": "var(--font-sans)",
};

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

/** The vendoring tool's zero-specificity confinement of every vendored rule. */
const VENDOR_SCOPE = ":where(.review-canvas-root) ";

function declarations(sheet: string, css = read(sheet)): Declaration[] {
  const out: Declaration[] = [];
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const match of body.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, " ").replaceAll(VENDOR_SCOPE, "");
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
const vendored = VENDORED_SHEETS.flatMap((sheet) => declarations(sheet));
/** Workbench variables upstream itself pins to `transparent` on the canvas. */
const pinned = new Set(
  vendored
    .filter((entry) => entry.property.startsWith("--vscode-") && entry.value === "transparent")
    .map((entry) => entry.property),
);
const resolvable = new Set([...defined, ...pinned]);

/** Top-level selector parts of every style rule, as written (keyframe stops and at-rule blocks skipped). */
/** A selector list's top-level parts (commas inside `:is()` or `[]` stay put). */
function splitSelector(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= selector.length; i++) {
    const char = selector[i];
    if (char === "(" || char === "[") depth++;
    else if (char === ")" || char === "]") depth--;
    else if ((char === "," && depth === 0) || i === selector.length) {
      parts.push(selector.slice(start, i).trim());
      start = i + 1;
    }
  }
  return parts;
}

function selectorParts(sheet: string): string[] {
  const body = read(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
  return [...body.matchAll(/([^{};]+)\{[^{}]*\}/g)]
    .flatMap((match) => splitSelector(match[1]!.trim().replace(/\s+/g, " ")))
    .filter((part) => !part.startsWith("@") && !/^(from|to|[\d.]+%)$/.test(part));
}

const monokai = declarations(
  "bb-monokai.css",
  readFileSync(path.resolve(APP, "../../../monokai/themes/bb-monokai.css"), "utf8"),
);
/** Tokens Monokai declares on `.dark` (plugins/monokai). */
const MONOKAI_DARK = monokai
  .filter((entry) => entry.selector === ".dark")
  .map((entry) => entry.property);

/** A font family named outright rather than through a token. */
const LITERAL_FACE =
  /["']|(?<![\w-])(?:monospace|serif|sans-serif|system-ui|-apple-system)(?![\w-])/;

/** Whether some tokens.css rule sets `property` on `part` (a vendored selector part). */
function overridesPart(property: string, part: string): boolean {
  return tokens
    .filter((entry) => entry.property === property)
    .flatMap((entry) => splitSelector(entry.selector))
    .some((selector) => {
      const subject = /^\.review-canvas-root\[data-review-theme\] (.+)$/.exec(selector)?.[1];
      if (!subject) return false;
      const members = /^:is\((.*)\)$/.exec(subject)?.[1]?.split(",") ?? [subject];
      return members
        .map((member) => member.trim())
        .some((member) => part === member || part.endsWith(` ${member}`));
    });
}

/**
 * Canvas controls whose upstream focus state is invisible or hover-identical,
 * each with the ring offset that keeps all four sides inside the box clipping it.
 */
const FOCUS_RINGS = [
  [".review-toc-link", "1px"],
  [".review-toc--rail .review-toc-link", "-2px"],
  [".review-toc-toggle", "-4px"],
  [".review-section-toggle", "1px"],
  [".review-diff-settings-button", "1px"],
  [".icon-button", "1px"],
  [".copy-for-agent-popover", "1px"],
  [".review-history-banner button", "1px"],
  [".side-panel-resizer", "-2px"],
  [".side-panel-sheet-resizer", "-2px"],
] as const;

/** The `property` tokens.css gives `control` on focus, from the last rule matching it (each later rule is more specific). */
function focusRing(control: string, property: string): string | undefined {
  return tokens.findLast((entry) => {
    const subject = /^\.review-canvas-root\[data-review-theme\] (.+):focus-visible$/.exec(
      entry.selector,
    )?.[1];
    if (entry.property !== property || !subject) return false;
    const members = /^:is\((.*)\)$/
      .exec(subject)?.[1]
      ?.split(",")
      .map((member) => member.trim()) ?? [subject];
    return members.some((member) => control === member || control.endsWith(` ${member}`));
  })?.value;
}

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

  it("resets colliding names without self-referencing", () => {
    for (const [name, value] of Object.entries(COLLISIONS)) {
      const values = tokens.filter((entry) => entry.property === name).map((entry) => entry.value);
      expect(values).toEqual([value]);
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

  it("confines vendored rules without specificity, so every override outranks them", () => {
    const unconfined = VENDORED_SHEETS.flatMap(selectorParts).filter(
      (part) => part !== ".review-canvas-root" && !part.startsWith(VENDOR_SCOPE),
    );
    const unprefixed = selectorParts("styles/tokens.css").filter(
      (part) => !part.startsWith(".review-canvas-root[data-review-theme"),
    );
    expect({ unconfined, unprefixed }).toEqual({ unconfined: [], unprefixed: [] });
  });

  it("never wraps a vendored sheet in @scope", () => {
    expect(VENDORED_SHEETS.filter((sheet) => /@scope/.test(read(sheet)))).toEqual([]);
  });

  it("sets every literal font face of the vendored rules in a bb face", () => {
    const literal = vendored
      .filter((entry) => entry.property === "font-family" || entry.property === "font")
      .filter((entry) => LITERAL_FACE.test(entry.value.replace(/var\([^()]*\)/g, "")))
      .flatMap((entry) => entry.selector.split(",").map((part) => part.trim()))
      .filter((part) => !overridesPart("font-family", part));
    expect(literal).toEqual([]);
  });

  it("overrides every literal color Monokai's dark Markdown rules paint", () => {
    const literal = monokai
      .filter((entry) => !entry.property.startsWith("mask") && LITERAL.test(entry.value))
      .flatMap((entry) =>
        entry.selector
          .split(",")
          .map((part) => part.trim())
          .filter((part) => part.startsWith(".dark .bb-markdown-prose "))
          .map((part) => ({ property: entry.property, part: part.slice(".dark ".length) })),
      );
    expect(literal.length).toBeGreaterThan(0);
    expect(literal.filter(({ property, part }) => !overridesPart(property, part))).toEqual([]);
  });

  it("drops every diff view override Monokai sets for dark mode only", () => {
    const darkOnly = MONOKAI_DARK.filter((name) => name.startsWith("--diffs-"));
    const dropped = new Set(
      tokens.filter((entry) => entry.value === "initial").map((entry) => entry.property),
    );
    expect(darkOnly.length).toBeGreaterThan(0);
    expect(darkOnly.filter((name) => !dropped.has(name))).toEqual([]);
  });

  it("draws an accent focus ring on every canvas control, inside any box that clips it", () => {
    const rings = FOCUS_RINGS.map(([control]) => [
      control,
      focusRing(control, "outline"),
      focusRing(control, "outline-offset"),
    ]);
    expect(rings).toEqual(
      FOCUS_RINGS.map(([control, offset]) => [control, "2px solid var(--timeline-accent)", offset]),
    );
  });
});

describe("authored sheets", () => {
  it("use theme tokens instead of color literals", () => {
    const sheets = readdirSync(path.join(APP, "styles")).filter(
      (file) => file.endsWith(".css") && file !== "tokens.css" && file !== "index.css",
    );
    const literals = sheets
      .flatMap((file) => declarations(`styles/${file}`))
      .filter((entry) => LITERAL.test(entry.value))
      .map((entry) => `${entry.sheet} ${entry.selector} ${entry.property}: ${entry.value}`);
    expect(literals).toEqual([]);
  });
});
