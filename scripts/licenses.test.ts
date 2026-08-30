// Each plugin is published as its own npm package, so each one has to carry the
// MIT notice itself — a LICENSE at the repo root is not in a leaf tarball. The
// copies are only safe if nothing lets them drift, hence this suite.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_LICENSES } from "./package-check";
import { workspacePlugins } from "./plugin-package";

const ROOT = join(import.meta.dir, "..");

const plugins = workspacePlugins(ROOT);

describe("licensing", () => {
  test("the repo has a root LICENSE", () => {
    const text = readFileSync(join(ROOT, "LICENSE"), "utf8");
    expect(text).toContain("MIT License");
    expect(text).toContain("Copyright (c)");
  });

  test("plugins were found", () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  for (const plugin of plugins) {
    test(`${plugin.id} carries a LICENSE identical to the root`, () => {
      const root = readFileSync(join(ROOT, "LICENSE"), "utf8");
      expect(readFileSync(join(plugin.dir, "LICENSE"), "utf8")).toBe(root);
    });

    test(`${plugin.id} declares an allowed licence in its manifest`, () => {
      // A plugin may add terms on top of MIT when it embeds third-party code
      // under them, but only an expression the publish gate also accepts.
      const license = plugin.manifest.license;
      if (license === undefined) throw new Error(`${plugin.id} has no package licence`);
      expect([...ALLOWED_LICENSES]).toContain(license);
    });

    test(`${plugin.id} ships its LICENSE in the npm tarball`, () => {
      // npm includes LICENSE implicitly, but an explicit entry keeps the
      // allowlist honest about everything the package distributes.
      expect(plugin.manifest.files).toContain("LICENSE");
    });
  }
});
