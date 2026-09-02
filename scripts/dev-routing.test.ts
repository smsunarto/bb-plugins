import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("managed dev routing", () => {
  test("root scripts route workspace preparation and screenshots through bb-kit", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      bbKit: { devInstance: { watchExclude: string[] } };
    };
    expect(packageJson.scripts.dev).toBe(
      "bun packages/bb-kit-core/src/bin/bin.ts dev-instance workspace --watch",
    );
    expect(packageJson.scripts["dev:instance"]).toBe(
      "bun packages/bb-kit-core/src/bin/bin.ts dev-instance workspace",
    );
    expect(packageJson.scripts["dev:setup"]).toBeUndefined();
    expect(packageJson.scripts["build:managed"]).toBeUndefined();
    expect(packageJson.bbKit.devInstance.watchExclude).toContain("agent-proxy");
    for (const name of ["screenshots", "screenshots:fixtures"]) {
      expect(packageJson.scripts[name]).toContain("dev-instance run --");
    }
  });

  test("direct plugin watchers require BB_CLI", () => {
    const offenders = readdirSync(join(ROOT, "plugins"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(ROOT, "plugins", entry.name, "package.json"))
      .filter(existsSync)
      .filter((path) => {
        const packageJson = JSON.parse(readFileSync(path, "utf8")) as {
          name?: string;
          scripts?: Record<string, string>;
        };
        if (!packageJson.name?.startsWith("@smsunarto/bb-plugin-")) return false;
        const dev = packageJson.scripts?.dev ?? "";
        const fallback = ["${BB_CLI:", "-bb}"].join("");
        return !dev.includes("${BB_CLI:?") || dev.includes(fallback);
      });
    expect(offenders).toEqual([]);
  });

  test("manual dev scripts stay deleted", () => {
    for (const file of [
      "bb-dev-cli",
      "bb-dev-instance.ts",
      "bb-dev-instance-setup.ts",
      "build-plugins-managed.ts",
    ]) {
      expect(existsSync(join(ROOT, "scripts", file))).toBe(false);
    }
  });
});
