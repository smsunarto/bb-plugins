import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rebuildPackedFrontend } from "./plugin-frontend-check";

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(helper: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-frontend-fixture-"));
  fixtures.push(dir);
  mkdirSync(join(dir, "dist"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-frontend-fixture",
      version: "1.0.0",
      type: "module",
      // Consumer installs must not resolve this development-only dependency.
      devDependencies: { "@get-bb/plugin-sdk": "0.0.0-unpublished-fixture" },
      files: ["dist", "app.ts", "lib", "tsconfig.json"],
      bb: {
        name: "Frontend fixture",
        description: "Tests packed frontend rebuilds.",
        branding: { icon: "Code" },
        server: "./dist/server.js",
        app: "./app.ts",
      },
    }),
  );
  writeFileSync(join(dir, "dist/server.js"), "export default function () {}\n");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        paths: { "@/*": ["./*"] },
      },
    }),
  );
  writeFileSync(
    join(dir, "app.ts"),
    `import { definePluginApp } from '@get-bb/plugin-sdk/app';
import { label } from './lib/helper';
export default definePluginApp({ sidebar: { title: label } });\n`,
  );
  writeFileSync(join(dir, "lib/helper.ts"), helper);
  return dir;
}

test("packed app rebuild uses relative imports and bb's frontend SDK shim", () => {
  const dir = fixture(`import type { BbPluginApi } from '@get-bb/plugin-sdk';
export const label = 'clean-install-regression-marker';\n`);
  expect(rebuildPackedFrontend(dir)).toContain("clean-install-regression-marker");
}, 60_000);

test("rejects the transitive backend SDK import from issue 128", () => {
  const dir = fixture(`import { defineRpcContract } from '@get-bb/plugin-sdk';
export const label = String(defineRpcContract({}));\n`);
  expect(() => rebuildPackedFrontend(dir)).toThrow('Could not resolve "@get-bb/plugin-sdk"');
}, 60_000);

test("rejects workspace aliases even when the config ships inside node_modules", () => {
  const dir = fixture("export const label = 'workspace-alias';\n");
  writeFileSync(join(dir, "app.ts"), "export { label as default } from '@/lib/helper';\n");
  expect(() => rebuildPackedFrontend(dir)).toThrow('Could not resolve "@/lib/helper"');
}, 60_000);
