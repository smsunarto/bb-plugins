import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtPath, problems, sourceDir, stale } from "./shadcn-registry";

const registryUrl =
  "https://raw.githubusercontent.com/smsunarto/bb-plugins/main/packages/ui/r/{name}.json";

test("the built registry matches its source", () => {
  expect(stale()).toEqual([]);
});

// Plugins take kit files only from this registry; bb's @bb registry would
// reintroduce copies the style contract cannot keep in sync.
test("every plugin configures the @bb-plugins registry and no other", () => {
  for (const id of readdirSync("plugins")) {
    const path = join("plugins", id, "components.json");
    let config: { registries?: Record<string, string> };
    try {
      config = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    expect(config.registries, path).toEqual({ "@bb-plugins": registryUrl });
  }
});

test("built paths map onto the plugin's ui and lib aliases", () => {
  expect(builtPath({ path: "stubs/button.tsx", type: "registry:ui" })).toBe(
    "registry/components/ui/button.tsx",
  );
  expect(builtPath({ path: "hooks/use-media-query.ts", type: "registry:ui" })).toBe(
    "registry/components/ui/hooks/use-media-query.ts",
  );
  expect(builtPath({ path: "stubs/utils.ts", type: "registry:lib" })).toBe("registry/lib/utils.ts");
  expect(builtPath({ path: "app-hooks/useBrowserDimmingModal.ts", type: "registry:hook" })).toBe(
    "registry/hooks/useBrowserDimmingModal.ts",
  );
});

test("flags items that would install wrong", () => {
  const root = mkdtempSync(join(tmpdir(), "shadcn-registry-"));
  mkdirSync(join(root, sourceDir), { recursive: true });
  writeFileSync(join(root, sourceDir, "commented.tsx"), "/* notice */\nexport {};\n");
  writeFileSync(join(root, sourceDir, "plain.tsx"), "export {};\n");
  const found = problems(
    {
      name: "test",
      homepage: "https://example.com",
      items: [
        {
          name: "commented",
          type: "registry:ui",
          files: [{ path: "commented.tsx", type: "registry:ui" }],
        },
        {
          name: "plain",
          type: "registry:ui",
          registryDependencies: ["button", "@bb/icon", "@bb-plugins/missing"],
          files: [{ path: "plain.tsx", type: "registry:ui", target: "components/ui/plain.tsx" }],
        },
      ],
    },
    root,
  );
  expect(found).toEqual([
    "commented: commented.tsx starts with a comment, which shadcn add strips",
    "plain: plain.tsx must not set a target; the plugin's aliases place it",
    "plain: button is not a @bb-plugins/ item; name it in docs",
    "plain: @bb/icon is not a @bb-plugins/ item; name it in docs",
    "plain: @bb-plugins/missing is not an item in this registry",
  ]);
});
