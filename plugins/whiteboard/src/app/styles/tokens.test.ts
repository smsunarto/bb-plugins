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

/** bb theme tokens (bb `apps/app/src/components/ui/theme.css`, both themes; monokai pins `.dark`). */
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
function selectorParts(sheet: string): string[] {
  const body = read(sheet).replace(/\/\*[\s\S]*?\*\//g, "");
  const parts: string[] = [];
  for (const match of body.matchAll(/([^{};]+)\{[^{}]*\}/g)) {
    const selector = match[1]!.trim().replace(/\s+/g, " ");
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
  }
  return parts.filter((part) => !part.startsWith("@") && !/^(from|to|[\d.]+%)$/.test(part));
}

/** Monokai's dark tokens (bb's `.dark` theme in plugins/monokai). */
const MONOKAI = new Map(
  declarations(
    "bb-monokai.css",
    readFileSync(path.resolve(APP, "../../../monokai/themes/bb-monokai.css"), "utf8"),
  )
    .filter((entry) => entry.selector === ".dark")
    .map((entry) => [entry.property, entry.value]),
);
const bridged = new Map(
  tokens
    .filter((entry) => entry.property.startsWith("--"))
    .map((entry) => [entry.property, entry.value]),
);

/** Every step of a `var()` chain through tokens.css, then Monokai. */
function resolveUnderMonokai(value: string): string[] {
  const steps = [value];
  let name = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
  while (name) {
    const next = bridged.get(name) ?? MONOKAI.get(name) ?? `unset ${name}`;
    steps.push(next);
    name = /^var\((--[\w-]+)\)$/.exec(next)?.[1];
  }
  return steps;
}

/** WCAG contrast of a `#rrggbb[aa]` color composited over an opaque `#rrggbb` ground. */
function contrast(foreground: string, ground: string): number {
  const channels = (hex: string) => {
    const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex);
    if (!match) throw new Error(`not a hex color: ${hex}`);
    const rgb = [0, 2, 4].map((i) => Number.parseInt(match[1]!.slice(i, i + 2), 16) / 255);
    return { rgb, alpha: match[2] ? Number.parseInt(match[2], 16) / 255 : 1 };
  };
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const back = channels(ground).rgb;
  const front = channels(foreground);
  const mixed = front.rgb.map((v, i) => v * front.alpha + back[i]! * (1 - front.alpha));
  const [high, low] = [luminance(mixed), luminance(back)].sort((a, b) => b - a);
  return (high! + 0.05) / (low! + 0.05);
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

  it("keeps faint labels readable under Monokai", () => {
    const inkFaint = vendored
      .filter((entry) => entry.property === "--ink-faint")
      .map((entry) => withoutBridgedFallbacks(entry.value, resolvable));
    expect(inkFaint).toEqual([
      "var(--vscode-disabledForeground)",
      "var(--vscode-disabledForeground)",
    ]);
    const steps = resolveUnderMonokai("var(--vscode-disabledForeground)");
    expect(steps.slice(0, 2)).toEqual([
      "var(--vscode-disabledForeground)",
      "var(--readback-foreground)",
    ]);
    expect(contrast(steps.at(-1)!, MONOKAI.get("--background")!)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps a collapsed section's title readable under Monokai", () => {
    const color = tokens.find(
      (entry) =>
        entry.selector ===
          ".review-canvas-root[data-review-theme] .review-section--collapsed .review-section-heading h2" &&
        entry.property === "color",
    );
    const steps = resolveUnderMonokai(color?.value ?? "unset");
    expect(contrast(steps.at(-1)!, MONOKAI.get("--background")!)).toBeGreaterThanOrEqual(3);
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
