import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

describe("managed dev routing", () => {
  test("root scripts route preparation, setup, screenshots, and watchers", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.dev).toBe("bun scripts/bb-dev-instance.ts --watch");
    expect(packageJson.scripts["dev:instance"]).toBe("bun scripts/bb-dev-instance.ts");
    expect(packageJson.scripts["build:managed"]).toBe(
      "bun run build:framework && bun scripts/build-plugins-managed.ts",
    );
    for (const name of ["dev:setup", "screenshots", "screenshots:fixtures"]) {
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

  test("the legacy adapter delegates and owns no checkout path", () => {
    const adapter = readFileSync(join(ROOT, "scripts", "bb-dev-cli"), "utf8");
    expect(adapter).toContain("packages/bb-kit-core/src/bin/bin.ts");
    expect(adapter).toContain("dev-instance exec --");
    expect(adapter).not.toContain("worktrees/dev");
    expect(adapter).not.toMatch(new RegExp(["BB_DEV_", "REPO\\b"].join("")));
  });
});
