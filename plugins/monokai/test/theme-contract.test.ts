import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { readCodeThemeRules } from "../scripts/code-theme-rules";
import { auditTheme, renderCodeTheme, renderTheme } from "../scripts/generate-theme";

const templatePath = fileURLToPath(new URL("../scripts/bb-monokai.template.css", import.meta.url));
const themePath = fileURLToPath(new URL("../themes/bb-monokai.css", import.meta.url));
const codeThemePath = fileURLToPath(new URL("../themes/bb-monokai-code.json", import.meta.url));
const template = await readFile(templatePath, "utf8");
const theme = await readFile(themePath, "utf8");
const codeTheme = await readFile(codeThemePath, "utf8");
const codeThemeRules = readCodeThemeRules().rules;

describe("bb Monokai contract audit", () => {
  test("the shipped CSS is generated from the code-owned roles and template", () => {
    expect(theme).toBe(renderTheme(template));
  });

  test("rejects an unknown template role", () => {
    expect(() => renderTheme(`${template}\n.x { color: {{text.foreign}}; }\n`)).toThrow(
      "Unknown theme role(s): text.foreign",
    );
  });

  test("rejects a rendered hex in the selector template", () => {
    expect(() => renderTheme(`${template}\n.x { color: #181818; }\n`)).toThrow(
      "Theme template contains rendered hex(es): #181818. Use symbolic roles.",
    );
  });

  test("the shipped theme follows the shared contract", () => {
    expect(() => auditTheme(theme)).not.toThrow();
  });

  test("rejects an off-contract rendered color", () => {
    const changed = theme.replace("--background: #181818", "--background: #123456");
    expect(() => auditTheme(changed)).toThrow("#123456 is off-contract");
  });

  test("rejects a missing token that would leak a bb default", () => {
    const changed = theme.replace("  --trees-status-added-override: #3fa266;\n", "");
    expect(() => auditTheme(changed)).toThrow(
      "--trees-status-added-override: MISSING (bb default leaks in)",
    );
  });

  test("rejects a contract color assigned to the wrong role", () => {
    const changed = theme.replace(
      "--trees-status-modified-override: #f1b467",
      "--trees-status-modified-override: #3fa266",
    );
    expect(() => auditTheme(changed)).toThrow(
      "--trees-status-modified-override: expected #f1b467, got #3fa266",
    );
  });

  test("rejects an illegible registered foreground/background pair", () => {
    const changed = theme.replace("--primary-foreground: #141414", "--primary-foreground: #e3e3dd");
    expect(() => auditTheme(changed)).toThrow("--primary-foreground on --primary:");
  });
});

describe("bb Monokai code theme", () => {
  test("the shipped JSON is generated from the vendored rules and the palette", () => {
    expect(codeTheme).toBe(`${JSON.stringify(renderCodeTheme(codeThemeRules), null, 2)}\n`);
  });

  test("it carries the shape bb parses and hands to Shiki", () => {
    const parsed = JSON.parse(codeTheme) as ReturnType<typeof renderCodeTheme>;
    expect(parsed.name.length).toBeGreaterThan(0);
    expect(parsed.type).toBe("dark");
    // Without these two Shiki falls back to a scopeless token rule, and this
    // theme has none — the code surface would render on bb's default ground.
    expect(parsed.colors["editor.background"]).toBe("#181818");
    expect(parsed.colors["editor.foreground"]).toBe("#e3e3dd");
    expect(parsed.tokenColors.length).toBeGreaterThan(0);
  });

  test("it maps Monaco CSS tokens onto the matching TextMate roles", () => {
    const parsed = JSON.parse(codeTheme) as ReturnType<typeof renderCodeTheme>;
    const foregroundByScope = new Map(
      parsed.tokenColors.flatMap((rule) => {
        const scopes = Array.isArray(rule.scope) ? rule.scope : [rule.scope];
        return scopes.map((scope) => [scope, rule.settings.foreground] as const);
      }),
    );

    expect(foregroundByScope.get("tag")).toBe("#fe5d86");
    expect(foregroundByScope.get("attribute.name")).toBe("#51dae9");
    expect(foregroundByScope.get("attribute.value")).toBe("#f7d05c");
    expect(foregroundByScope.get("attribute.value.number")).toBe("#a895fe");
    expect(foregroundByScope.get("attribute.value.number.css")).toBe("#a895fe");
    expect(foregroundByScope.get("attribute.value.hex.scss")).toBe("#a895fe");
    expect(foregroundByScope.get("attribute.value.unit.less")).toBe("#a895fe");
    expect(foregroundByScope.get("delimiter")).toBe("#e3e3dd");
  });

  test("rejects a chrome-only role on a token", () => {
    expect(() => renderCodeTheme([{ scope: ["keyword"], foreground: "accent.base" }])).toThrow(
      "keyword: accent.base is not a token role",
    );
  });

  test("rejects an unregistered role on a token", () => {
    expect(() => renderCodeTheme([{ scope: ["keyword"], background: "code.foreign" }])).toThrow(
      "keyword: code.foreign is not a token role",
    );
  });

  test("rejects a rule that styles nothing", () => {
    expect(() => renderCodeTheme([{ scope: ["keyword"] }])).toThrow(
      "keyword: a rule with no settings",
    );
  });

  test("rejects a rule that scopes nothing", () => {
    expect(() => renderCodeTheme([{ scope: [], foreground: "code.keyword" }])).toThrow(
      "a rule carries no scope",
    );
  });
});
