import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sharedStyles } from "./shared-ui-styles";
import { monokaiUtilityCSS } from "./storybook-theme";

test("shared theme aliases follow every Monokai color token", () => {
  expect(readFileSync("packages/ui/theme.css", "utf8")).toBe(
    monokaiUtilityCSS(readFileSync("plugins/monokai/themes/bb-monokai.css", "utf8")),
  );
});

function checkUtils(root: string) {
  const path = join(root, "utils.ts");
  if (!existsSync(path)) return;
  const source = readFileSync(path, "utf8");
  expect(source, path).toContain('from "@bb-plugins/ui/utils"');
  expect(source, path).not.toContain("function cn(");
}
function checkControls(root: string) {
  for (const [name, extension] of [
    ["button", "tsx"],
    ["input", "tsx"],
    ["textarea", "tsx"],
    ["motion", "ts"],
  ]) {
    const path = join(root, `${name}.${extension}`);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    expect(source, path).toContain(`from "@bb-plugins/ui/${name}"`);
    expect(source, path).not.toMatch(/(?:function\s|forwardRef|\bcva\()/);
  }
}
test("plugin control entry points remain shared when registry components are regenerated", () => {
  let consumers = 0;
  for (const id of readdirSync("plugins")) {
    const root = join("plugins", id);
    const manifest = join(root, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    if (!pkg.devDependencies?.["@bb-plugins/ui"]) continue;
    consumers += 1;
    expect(pkg.dependencies?.["@bb-plugins/ui"]).toBeUndefined();
    for (const directory of ["lib", "src/app/lib"]) checkUtils(join(root, directory));
    for (const directory of ["components/ui", "src/app/components/ui"])
      checkControls(join(root, directory));
  }
  expect(consumers).toBeGreaterThan(0);
});

test("shared selectors match their content fingerprint", () => {
  const source = readFileSync("packages/ui/src/controls.css", "utf8");
  const result = sharedStyles(source);
  expect(result.css).toBe(source);
  expect(result.classes).toBe(readFileSync("packages/ui/src/styles.ts", "utf8"));
  expect(sharedStyles(source + "\n/* changed */").classes).not.toBe(result.classes);
});
