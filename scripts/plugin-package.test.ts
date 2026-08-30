// derivePluginId decides the id bb uses for routes, storage, settings, and CLI
// commands. If these scripts derive it differently from bb, they address
// plugins by a name bb never had — so this suite pins the shared rule and the
// invariant the rest of the repo leans on: directory name == plugin id.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  derivePluginId,
  isPluginPackageName,
  unscopedPackageName,
  workspacePlugins,
} from "./plugin-package";

const ROOT = join(import.meta.dir, "..");

describe("derivePluginId", () => {
  test("a scope changes nothing about the id", () => {
    expect(derivePluginId("bb-plugin-notify")).toBe("notify");
    expect(derivePluginId("@smsunarto/bb-plugin-notify")).toBe("notify");
    expect(derivePluginId("@smsunarto/bb-plugin-gh-stack")).toBe("gh-stack");
  });

  test("normalizes the way bb does", () => {
    expect(derivePluginId("@scope/BB-Plugin-Thing")).toBe("bb-plugin-thing");
    expect(derivePluginId("bb-plugin-My_Thing")).toBe("my-thing");
    expect(derivePluginId("plain")).toBe("plain");
    expect(() => derivePluginId("@scope/bb-plugin-")).toThrow();
  });
});

describe("isPluginPackageName", () => {
  test("matches the prefix after the scope, not before it", () => {
    expect(isPluginPackageName("bb-plugin-monokai")).toBe(true);
    expect(isPluginPackageName("@smsunarto/bb-plugin-monokai")).toBe(true);
    expect(isPluginPackageName("@bb-plugin-monokai/tool")).toBe(false);
    expect(isPluginPackageName("bb-plugins")).toBe(false);
    expect(isPluginPackageName(undefined)).toBe(false);
  });

  test("unscopedPackageName keeps an unscoped name whole", () => {
    expect(unscopedPackageName("bb-plugin-monokai")).toBe("bb-plugin-monokai");
    expect(unscopedPackageName("@smsunarto/bb-plugin-monokai")).toBe("bb-plugin-monokai");
  });
});

describe("the workspace", () => {
  const plugins = workspacePlugins(ROOT);

  test("holds plugin packages", () => {
    expect(plugins.length).toBeGreaterThan(0);
  });

  for (const plugin of plugins) {
    // plugin-icons.ts and every path in the docs key off the directory name,
    // while bb keys off the derived id. They have to agree or a rename silently
    // addresses the wrong plugin.
    test(`${plugin.directory} is named for the id bb derives from it`, () => {
      expect(plugin.id).toBe(plugin.directory);
    });

    test(`${plugin.directory} publishes under the @smsunarto scope`, () => {
      expect(plugin.name).toBe(`@smsunarto/bb-plugin-${plugin.directory}`);
    });
  }
});
