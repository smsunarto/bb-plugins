import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { previewSurfaceClass } from "../.storybook/surfaces";

// Explicit surface inventory. Each entry requires a particular story and its
// production import/registration, so a lone Button story cannot satisfy coverage.
const surfaces: Record<string, Record<string, string[]>> = {
  "agent-instructions": { rules: ["RuleCard"], screens: ["../src/app/app"] },
  agentation: { panel: ["AnnotationPanel"] },
  amp: { oracle: ["../app"] },
  canvas: {
    components: ["componentTable", "CanvasStateProvider"],
    charts: ["BarChart", "LineChart", "PieChart", "UsageBar"],
  },
  cloudflare: { controls: ["Notice", "CopyButton", "Badge"], shares: ["QuickShareCard"] },
  "code-review": {
    comments: ["CommentForm"],
    explorer: ["FileExplorer"],
    findings: ["FindingCard"],
    status: ["PrStateBadge", "ReviewStateBadge", "BranchStatusChip"],
    sync: ["SyncState"],
  },
  devin: { cloud: ["../src/app/app"] },
  dotfiles: { editor: ["WorkingFileEditor", "HostPicker"], screens: ["DotfilesPage"] },
  "game-studio": {
    canvas: ["StudioCanvas"],
    generation: ["GenerationSettings", "CanvasInputs", "BriefStarters"],
    review: ["VerdictBadge"],
  },
  "gh-stack": { files: ["ChangedFileTree"], stack: ["../app"] },
  gitbutler: {
    files: ["FileList", "WorkspaceSkeleton", "Notice"],
    workspace: ["StackLane", "BranchActions", "Conflicts"],
    history: ["OperationHistory"],
  },
  "gtd-sidebar": { threads: ["ThreadCard", "RenameProvider"], indicators: ["StatusGlyph"] },
  html: { tweaks: ["TweakPanel"] },
  "kitchen-sink": { comparison: ["SmartImageCompareDirective", "DevinIcon"] },
  monokai: {
    "bb-monokai": [
      "export:Foundations",
      "export:ContentPalettes",
      "export:ChromeAndStates",
      "export:SurfaceComposition",
    ],
  },
  "prompt-editor": { editor: ["../src/app/app"] },
  "scott-docs": { documents: ["../app"], cards: ["../app"] },
  "scott-tasks": {
    views: ["ListView", "BoardView", "DetailView", "ManagePanel"],
    controls: ["StatusIcon", "PriorityIcon", "ColorSwatchPicker", "CheckboxField", "ConfirmDialog"],
  },
  traces: { inspector: ["JsonView", "QueryError", "Pages"] },
  vimium: { hints: ["mountPluginContentScripts", "../src/app/app"] },
  whiteboard: { markdown: ["AgentMarkdown", "EmptyState"], files: ["DiffFileTree"] },
};

// Deliberate boundaries: host-only providers/services and Usage Bar's native
// macOS menu have no browser component. SDK-owned icons, Markdown, navigation,
// and composer are substituted by the official harness and need live BB checks.
// Private rendering helpers are exercised through the parent surfaces above.
test("every browser plugin has an explicit surface inventory", () => {
  const browserPlugins = readdirSync("plugins", { withFileTypes: true })
    .filter((directory) => directory.isDirectory() && !directory.name.startsWith("."))
    .filter((directory) => {
      const path = join("plugins", directory.name, "package.json");
      return existsSync(path) && JSON.parse(readFileSync(path, "utf8")).bb?.app;
    })
    .map((directory) => directory.name)
    .sort();
  expect(Object.keys(surfaces).sort()).toEqual(browserPlugins);
});

function importedSurfaces(source: string): Set<string> {
  const file = ts.createSourceFile(
    "story.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      if (ts.isStringLiteral(node.moduleSpecifier)) found.add(node.moduleSpecifier.text);
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements)
          found.add((binding.propertyName ?? binding.name).text);
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const source = node.arguments[0];
      if (source && ts.isStringLiteral(source)) found.add(source.text);
    }
    if (
      ts.isVariableStatement(node) &&
      node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) found.add(`export:${declaration.name.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

for (const [plugin, inventory] of Object.entries(surfaces)) {
  test(`${plugin}: required component stories remain present`, () => {
    for (const [story, expectedSurfaces] of Object.entries(inventory)) {
      const path = join("plugins", plugin, "storybook", `${story}.stories.tsx`);
      expect(existsSync(path), path).toBe(true);
      const source = readFileSync(path, "utf8");
      const imports = importedSurfaces(source);
      for (const surface of expectedSurfaces)
        expect(imports.has(surface), `${path}: import or export ${surface}`).toBe(true);
      expect(source).toMatch(/export const \w+/);
    }
  });
}

test("stories are grouped into Components or Screens", () => {
  for (const root of ["plugins", "packages"]) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const directory = join(root, entry.name, "storybook");
      if (!entry.isDirectory() || !existsSync(directory)) continue;
      for (const name of readdirSync(directory).filter((name) => name.endsWith(".stories.tsx"))) {
        const path = join(directory, name);
        expect(readFileSync(path, "utf8"), path).toMatch(/title:\s*"(?:Components|Screens)\//);
      }
    }
  }
});

test("plugin styles apply to component and screen previews", () => {
  for (const root of ["Components", "Screens"]) {
    expect(previewSurfaceClass(`${root}/Game Studio/Canvas`)).toBe("gs-app");
    expect(previewSurfaceClass(`${root}/Cloudflare/Quick shares`)).toBe("cf-panel");
    expect(previewSurfaceClass(`${root}/Tasks/Views`)).toBeUndefined();
    expect(previewSurfaceClass(`${root}/Cloudflare Other/Panel`)).toBeUndefined();
  }
});
