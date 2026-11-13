import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  fixFor,
  isReExport,
  readBaseline,
  scanFile,
  scanRepository,
  scanned,
  scanRegistry,
  unrecorded,
} from "./style-contract";

const rulesIn = (file: string, source: string) => scanFile(file, source).map((v) => v.rule);

test("plugins add no style drift beyond the frozen baseline", () => {
  const added = unrecorded(scanRepository(), readBaseline());
  const report = added.map(
    (v) => `${v.file}:${v.line} ${v.rule}: ${fixFor(v.rule)}\n  ${v.source}`,
  );
  expect(report).toEqual([]);
});

test("flags hand-picked edges, colors, and universal-bucket utilities", () => {
  const tsx = "a.tsx";
  expect(rulesIn(tsx, `<div className="border border-border/60" />`)).toEqual(["edge-opacity"]);
  expect(rulesIn(tsx, `<b className="ring-1 ring-border ring-inset" />`)).toEqual(["ring-edge"]);
  expect(rulesIn(tsx, `<b className="rounded-[7px] shadow-[0_0_0_1px_red]" />`)).toEqual([
    "arbitrary-edge",
    "arbitrary-edge",
  ]);
  expect(rulesIn(tsx, `<ul className="space-y-2" />`)).toEqual(["universal-bucket"]);
  expect(rulesIn(tsx, `<i style={{ color: "#ff0000" }} />`)).toEqual(["raw-color"]);
  expect(
    rulesIn("a.css", `.x { box-shadow: 0 0 0 0.5px color-mix(in srgb, red 8%, blue); }`),
  ).toEqual(["hairline-literal", "raw-color"]);
});

test("leaves focus and selection rings, theme utilities, and comments alone", () => {
  const tsx = "a.tsx";
  expect(
    rulesIn(tsx, `<b className="focus-visible:ring-1 ring-2 ring-ring border-border" />`),
  ).toEqual([]);
  expect(rulesIn(tsx, `// issue #128 used border-border/60\nconst a = 1;`)).toEqual([]);
  expect(rulesIn("a.css", `/* #fff 0.5px */ .x { color: var(--foreground); }`)).toEqual([]);
  expect(rulesIn(tsx, `const url = "https://x.test/#abc";`)).toEqual([]);
});

test("accepts a shared primitive only as a re-export", () => {
  expect(isReExport(`export { Button, type ButtonProps } from "@bb-plugins/ui/button";\n`)).toBe(
    true,
  );
  expect(isReExport(`export {\n  Card,\n  CardHeader,\n} from "@bb-plugins/ui/card";\n`)).toBe(
    true,
  );
  expect(
    isReExport(`import { cva } from "class-variance-authority";\nexport function Button() {}`),
  ).toBe(false);
});

test("exempts the palette owner, the shared package, tests, and build output", () => {
  expect(scanned("plugins/source-control/src/app/ui.tsx")).toBe(true);
  expect(scanned("plugins/monokai/app/diff-header.css")).toBe(false);
  expect(scanned("packages/ui/src/controls.css")).toBe(false);
  expect(scanned("plugins/genui/dist/app.css")).toBe(false);
  expect(scanned("plugins/genui/ui/Table.test.tsx")).toBe(false);
});

test("a vendored kit file must match its canonical registry copy", () => {
  const canonical = "packages/ui/registry/drawer.tsx";
  const source = readFileSync(canonical, "utf8");
  expect(scanRegistry("plugins/x/components/ui/drawer.tsx", source)).toEqual([]);
  expect(scanRegistry("plugins/x/src/app/components/ui/drawer.tsx", source + "\n")).toEqual([
    {
      file: "plugins/x/src/app/components/ui/drawer.tsx",
      rule: "registry-drift",
      line: 1,
      source: "drawer.tsx",
    },
  ]);
  expect(scanRegistry("plugins/x/components/ui/not-in-registry.tsx", "x")).toEqual([]);
});
