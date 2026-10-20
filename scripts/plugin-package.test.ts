// derivePluginId decides the id bb uses for routes, storage, and settings.
// If these scripts derive it differently from bb, they address
// plugins by a name bb never had — so this suite pins the shared rule and the
// invariant the rest of the repo leans on: directory name == plugin id. A
// plugin renamed for users is the one listed exception: it keeps its stored id.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  derivePluginId,
  isPluginPackageName,
  unscopedPackageName,
  workspacePlugins,
} from "./plugin-package";

const ROOT = join(import.meta.dir, "..");

/**
 * Directory (= catalog id, CLI, and bb-kit `publicName`) → the id bb already
 * stores settings, routes, and thread metadata under. Renaming the package
 * would orphan that data, so a renamed plugin is listed here explicitly.
 */
const STORED_IDS: Record<string, string> = { "dev-mode": "scott-engineering" };

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

  test("every stored-id exception is a workspace plugin", () => {
    const directories = new Set(plugins.map((plugin) => plugin.directory));
    expect(Object.keys(STORED_IDS).filter((directory) => !directories.has(directory))).toEqual([]);
  });

  for (const plugin of plugins) {
    const storedId = STORED_IDS[plugin.directory];
    if (storedId !== undefined) {
      test(`${plugin.directory} keeps stored id ${storedId} behind its public name`, () => {
        expect(plugin.id).toBe(storedId);
        expect(plugin.name).toBe(`@smsunarto/bb-plugin-${storedId}`);
        const serverPath = join(plugin.dir, plugin.manifest.bb?.server ?? "");
        expect(existsSync(serverPath)).toBe(true);
        const server = readFileSync(serverPath, "utf8");
        expect(server).toContain(`pluginId: "${storedId}",`);
        expect(server).toContain(`publicName: "${plugin.directory}",`);
      });
      continue;
    }

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

describe("catalogs", () => {
  test("the collection lists every marketplace plugin", () => {
    const collection = JSON.parse(readFileSync(join(ROOT, ".bb/plugins.json"), "utf8")) as {
      plugins: { name: string; source: string }[];
    };
    const marketplace = JSON.parse(readFileSync(join(ROOT, "marketplace.json"), "utf8")) as {
      plugins: { id: string }[];
    };
    const byName = new Map(collection.plugins.map((entry) => [entry.name, entry]));

    expect(marketplace.plugins.map((entry) => entry.id).filter((id) => !byName.has(id))).toEqual(
      [],
    );
    for (const entry of marketplace.plugins) {
      expect(byName.get(entry.id)?.source).toBe(`./plugins/${entry.id}`);
    }
  });
});
