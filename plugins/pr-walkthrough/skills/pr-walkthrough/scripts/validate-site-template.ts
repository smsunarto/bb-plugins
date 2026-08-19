// Validate the reusable PR walkthrough source and static export.
//
// Run with Bun:  bun run <skill-directory>/scripts/validate-site-template.ts --site DIR [--built]

import * as fs from "node:fs";
import * as path from "node:path";

const REQUIRED_FILES = [
  "package.json",
  "next.config.mjs",
  "components.json",
  ".oxlintrc.json",
  "scripts/compile-walkthrough.ts",
  "scripts/guide-contract.ts",
  "src/app/page.mdx",
  "src/content/walkthrough/index.mdx",
  "src/components/walkthrough/walkthrough-app.tsx",
  "src/components/walkthrough/diff-options.ts",
  "src/components/walkthrough/guide-content.tsx",
  "src/components/walkthrough/guide-diagram.tsx",
  "src/components/walkthrough/guide-document.tsx",
  "src/components/walkthrough/guide-line-comment.tsx",
  "src/components/walkthrough/review-context-sidebar.tsx",
  "src/components/walkthrough/review-document.tsx",
  "src/components/walkthrough/review-group-rail.tsx",
  "src/components/walkthrough/review-surface.ts",
  "src/components/walkthrough/source-diff.tsx",
  "src/components/walkthrough/source.tsx",
  "src/components/ui/empty.tsx",
  "src/components/ui/accordion.tsx",
  "src/components/ui/button-group.tsx",
  "src/components/ui/item.tsx",
  "src/components/ui/toggle.tsx",
  "src/components/ui/toggle-group.tsx",
  "src/data/walkthrough.generated.json",
  "src/data/walkthrough.patch",
];
const REQUIRED_DEPENDENCIES = [
  "@pierre/diffs",
  "@pierre/trees",
  "@xyflow/react",
  "next",
  "nextra",
  "nextra-theme-docs",
  "radix-ui",
];
const FORBIDDEN_FILES = [
  "design-qa.md",
  "src/components/ui/card.tsx",
  "src/components/walkthrough/graph-canvas.tsx",
  "src/components/walkthrough/diff-browser.tsx",
];
const FORBIDDEN_DEPENDENCIES: string[] = [];
// No font binary ships with the template, so the mono stack must stand on the
// system fonts alone. A licensed local install is an optional first choice.
const MONO_STACK_FALLBACK = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';
const FULL_CONTEXT_MARKER = "src/data/full-context.enabled";
const GUIDE_PHASES = [
  "foundations",
  "apis",
  "behavior",
  "integration",
  "tests",
  "misc",
  "generated",
];
const HEAD_SHA = /^[0-9a-f]{40}$/;

const USAGE = `usage: validate-site-template.ts [-h] --site SITE [--built]

Validate the reusable PR walkthrough source and static export.
`;

function usageError(message: string): never {
  process.stderr.write(USAGE);
  process.stderr.write(`validate-site-template.ts: error: ${message}\n`);
  process.exit(2);
}

function parseCliArgs(
  argv: string[],
  optionNames: string[],
  flagNames: string[],
): { values: Map<string, string>; flags: Set<string> } {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (equals < 0 && flagNames.includes(name)) {
      flags.add(name);
      index += 1;
      continue;
    }
    if (optionNames.includes(name)) {
      if (equals >= 0) {
        values.set(name, token.slice(equals + 1));
        index += 1;
        continue;
      }
      const value: string | undefined = argv[index + 1];
      if (value === undefined) usageError(`argument ${name}: expected one argument`);
      values.set(name, value);
      index += 2;
      continue;
    }
    usageError(`unrecognized arguments: ${token}`);
  }
  return { values, flags };
}

/** Resolve like Python's Path.resolve(): absolute, with symlinks followed. */
function resolveRealPath(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return absolute;
    return path.join(resolveRealPath(parent), path.basename(absolute));
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function exists(target: string): boolean {
  try {
    fs.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function readText(target: string): string {
  return fs.readFileSync(target, "utf8");
}

/** Decode ignoring undecodable bytes, like Python's errors="ignore". */
function readTextLossy(target: string): string {
  return fs.readFileSync(target, "utf8").split("�").join("");
}

function readJson(target: string): unknown {
  return JSON.parse(readText(target));
}

function modifiedSeconds(target: string): number {
  return fs.statSync(target).mtimeMs / 1000;
}

function collectFiles(root: string, suffix: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) found.push(next);
    }
  };
  walk(root);
  return found;
}

function listFiles(directory: string, suffix: string): string[] {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => path.join(directory, entry.name));
  } catch {
    return [];
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function display(value: unknown): string {
  return value === undefined || value === null ? "None" : String(value);
}

function main(argv: string[]): number {
  const parsed = parseCliArgs(argv, ["--site"], ["--built"]);
  const siteArg = parsed.values.get("--site");
  if (siteArg === undefined) usageError("the following arguments are required: --site");
  const built = parsed.flags.has("--built");
  const site = resolveRealPath(siteArg);
  const at = (...parts: string[]): string => path.join(site, ...parts);
  const errors: string[] = [];

  for (const relativePath of REQUIRED_FILES) {
    if (!isFile(at(relativePath))) errors.push(`missing ${relativePath}`);
  }
  for (const relativePath of FORBIDDEN_FILES) {
    if (exists(at(relativePath))) {
      errors.push(`removed walkthrough component is still present: ${relativePath}`);
    }
  }

  const packagePath = at("package.json");
  if (isFile(packagePath)) {
    const pkg = readJson(packagePath) as Record<string, unknown>;
    const dependencies = isRecord(pkg.dependencies) ? pkg.dependencies : {};
    for (const dependency of REQUIRED_DEPENDENCIES) {
      if (!(dependency in dependencies)) errors.push(`missing dependency ${dependency}`);
    }
    for (const dependency of FORBIDDEN_DEPENDENCIES) {
      if (dependency in dependencies) {
        errors.push(`removed dependency is still present: ${dependency}`);
      }
    }
    const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
    for (const script of ["generate", "dev", "build", "lint", "typecheck", "check"]) {
      if (!(script in scripts)) errors.push(`missing package script ${script}`);
    }
  }

  const pagePath = at("src", "app", "page.mdx");
  if (isFile(pagePath) && !readText(pagePath).includes("<WalkthroughApp")) {
    errors.push("page.mdx must render WalkthroughApp");
  }

  const globalsPath = at("src", "app", "globals.css");
  if (isFile(globalsPath)) {
    const globalsText = readText(globalsPath);
    for (const marker of [
      "--font-mono:",
      MONO_STACK_FALLBACK,
      "--diffs-font-family: var(--font-mono)",
    ]) {
      if (!globalsText.includes(marker)) errors.push(`globals.css is missing ${marker}`);
    }
    if (!globalsText.includes("--diffs-gap-block: 8px")) {
      errors.push("globals.css must preserve Pierre's 8px block rhythm");
    }
  }

  const compilerPath = at("scripts", "compile-walkthrough.ts");
  if (isFile(compilerPath)) {
    const compilerText = readText(compilerPath);
    for (const marker of [
      "compileGuide",
      "headSha",
      "GENERIC_SUMMARY_PREFIXES",
      "needs an 8–36 word concrete summary",
      "summary must start with a subsystem or mechanism",
      "summary must add information beyond Objective",
      "classifyGeneratedFile",
      "rejectLegacyLensSyntax",
      "MAX_EXPANDABLE_BLOB_BYTES",
      "MAX_EMBEDDED_CONTEXT_BYTES",
      "readGitBlob",
      "--include-full-context",
    ]) {
      if (!compilerText.includes(marker)) errors.push(`walkthrough compiler is missing ${marker}`);
    }
  }

  const guideContractPath = at("scripts", "guide-contract.ts");
  if (isFile(guideContractPath)) {
    const guideContractText = readText(guideContractPath);
    for (const marker of [
      "PHASES",
      "needs exactly one Diff directive",
      "covers changed lines more than once",
      "countsTowardCompletion",
      "guide-diagram",
      "lineNumber",
    ]) {
      if (!guideContractText.includes(marker)) {
        errors.push(`Guide compiler contract is missing ${marker}`);
      }
    }
  }

  const sourceRoot = at("src", "content", "walkthrough");
  if (exists(path.join(sourceRoot, "lenses"))) {
    errors.push("walkthrough source must not contain the removed lenses directory");
  }
  const sourcePath = path.join(sourceRoot, "index.mdx");
  const sourceFiles = collectFiles(sourceRoot, ".mdx");
  if (isFile(sourcePath)) {
    const source = readText(sourcePath);
    if (!source.includes("# Review guide") || !source.includes("- Section:")) {
      errors.push("walkthrough/index.mdx must define the ordered review guide");
    }
  }
  for (const sectionPath of sourceFiles) {
    if (sectionPath === sourcePath) continue;
    if (countOccurrences(readText(sectionPath), "## Guide") !== 1) {
      errors.push(`${path.relative(site, sectionPath)} must contain exactly one Guide section`);
    }
  }

  const dataPath = at("src", "data", "walkthrough.generated.json");
  let data: Record<string, unknown> | null = null;
  if (isFile(dataPath)) {
    const generatedInputs = [...sourceFiles];
    for (const generatedInput of [
      at("src", "data", "walkthrough.patch"),
      at(FULL_CONTEXT_MARKER),
    ]) {
      if (isFile(generatedInput)) generatedInputs.push(generatedInput);
    }
    if (
      generatedInputs.length > 0 &&
      modifiedSeconds(dataPath) < Math.max(...generatedInputs.map(modifiedSeconds))
    ) {
      errors.push("generated walkthrough data is older than its canonical inputs");
    }
    data = readJson(dataPath) as Record<string, unknown>;
    if ("graphs" in data) {
      errors.push("walkthrough data must not contain the removed graphs output");
    }
    const meta = data.meta;
    const headSha = isRecord(meta) ? meta.headSha : undefined;
    if (!isRecord(meta) || !HEAD_SHA.test(headSha === undefined ? "" : String(headSha))) {
      errors.push("walkthrough data meta.headSha must be a lowercase 40-character Git SHA");
    }
    let diffFiles: Array<Record<string, unknown>> = [];
    if (!Array.isArray(data.diffFiles)) {
      errors.push("walkthrough data must contain a diffFiles list");
    } else {
      diffFiles = data.diffFiles as Array<Record<string, unknown>>;
      const fullContextFiles: Array<Record<string, unknown>> = [];
      for (const file of diffFiles) {
        if (typeof file.generated !== "boolean") {
          errors.push(`diff file ${display(file.path)} must contain a generated boolean`);
        }
        const reason = file.generatedReason;
        if (reason !== undefined && reason !== null && typeof reason !== "string") {
          errors.push(`diff file ${display(file.path)} generatedReason must be text`);
        }
        const oldContents = file.oldContents;
        const newContents = file.newContents;
        const oldMissing = oldContents === undefined || oldContents === null;
        const newMissing = newContents === undefined || newContents === null;
        if (oldMissing !== newMissing) {
          errors.push(
            `diff file ${display(file.path)} must provide oldContents and newContents together`,
          );
        }
        if (!oldMissing && typeof oldContents !== "string") {
          errors.push(`diff file ${display(file.path)} oldContents must be text`);
        }
        if (!newMissing && typeof newContents !== "string") {
          errors.push(`diff file ${display(file.path)} newContents must be text`);
        }
        if (file.binary && (!oldMissing || !newMissing)) {
          errors.push(`binary diff file ${display(file.path)} must not embed full context`);
        }
        if (typeof oldContents === "string" && typeof newContents === "string") {
          fullContextFiles.push(file);
        }
      }

      const fullContextEnabled = isFile(at(FULL_CONTEXT_MARKER));
      const eligibleContextFiles = diffFiles.filter(
        (file) =>
          (file.status === "modified" || file.status === "renamed" || file.status === "copied") &&
          !file.binary,
      );
      if (fullContextEnabled && eligibleContextFiles.length > 0 && fullContextFiles.length === 0) {
        errors.push("full-context mode is enabled but no eligible diff has exact old/new contents");
      }
      if (!fullContextEnabled && fullContextFiles.length > 0) {
        errors.push("exact old/new contents require the explicit full-context marker");
      }
    }

    const reviewGroups = data.reviewGroups;
    if (!Array.isArray(reviewGroups) || reviewGroups.length === 0) {
      errors.push("walkthrough data must contain non-empty reviewGroups");
    } else {
      const groups = reviewGroups as Array<Record<string, unknown>>;
      const groupIds = groups.map((group) => group.id);
      if (new Set(groupIds).size !== groupIds.length) {
        errors.push("reviewGroups must use unique IDs");
      }
      const guideExcerptIds: string[] = [];
      for (const group of groups) {
        if ("lenses" in group) {
          errors.push(
            `review group ${display(group.id)} must not contain the removed lenses output`,
          );
        }
        const guide = group.guide;
        const phases = isRecord(guide) ? guide.phases : null;
        if (!Array.isArray(phases) || phases.length === 0) {
          errors.push(`review group ${display(group.id)} must contain non-empty Guide phases`);
          continue;
        }
        const phaseList = phases as unknown[];
        const phaseIds = phaseList
          .filter((phase) => isRecord(phase))
          .map((phase) => (phase as Record<string, unknown>).id);
        const expectedOrder = GUIDE_PHASES.filter((phaseId) => phaseIds.includes(phaseId));
        if (
          phaseIds.length !== expectedOrder.length ||
          phaseIds.some((phaseId, index) => phaseId !== expectedOrder[index]) ||
          new Set(phaseIds).size !== phaseIds.length
        ) {
          errors.push(
            `review group ${display(group.id)} Guide phases must be a unique canonical-order subset`,
          );
        }
        for (const rawPhase of phaseList) {
          if (!isRecord(rawPhase)) {
            errors.push(`review group ${display(group.id)} contains an invalid Guide phase`);
            continue;
          }
          const phase = rawPhase;
          const phaseId = phase.id;
          if (!Array.isArray(phase.explanation) || phase.explanation.length === 0) {
            errors.push(`Guide phase ${display(phaseId)} needs explanatory content`);
          }
          if (typeof phase.defaultCollapsed !== "boolean") {
            errors.push(`Guide phase ${display(phaseId)} needs a defaultCollapsed boolean`);
          }
          const diagram = phase.diagram;
          if (diagram !== undefined && diagram !== null) {
            if (!isRecord(diagram) || !diagram.summary) {
              errors.push(`Guide phase ${display(phaseId)} has an invalid optional diagram`);
            } else if (!Array.isArray(diagram.nodes) || !Array.isArray(diagram.edges)) {
              errors.push(`Guide phase ${display(phaseId)} diagram needs node and edge lists`);
            }
          }
          const excerpts = phase.excerpts;
          if (!Array.isArray(excerpts) || excerpts.length === 0) {
            errors.push(`Guide phase ${display(phaseId)} must contain excerpts`);
            continue;
          }
          for (const rawExcerpt of excerpts as unknown[]) {
            const excerpt = isRecord(rawExcerpt) ? rawExcerpt : null;
            const excerptId = excerpt ? excerpt.id : null;
            if (!excerpt || typeof excerptId !== "string") {
              errors.push(`Guide phase ${display(phaseId)} contains an invalid excerpt`);
              continue;
            }
            guideExcerptIds.push(excerptId);
            if (!Array.isArray(excerpt.explanation) || excerpt.explanation.length === 0) {
              errors.push(`Guide excerpt ${excerptId} needs explanatory content`);
            }
            if (!Array.isArray(excerpt.comments)) {
              errors.push(`Guide excerpt ${excerptId} comments must be a list`);
            }
            const excluded = Boolean(excerpt.generated || excerpt.binary);
            if (excerpt.countsTowardCompletion !== !excluded) {
              errors.push(
                `Guide excerpt ${excerptId} completion eligibility must exclude only generated or binary files`,
              );
            }
          }
        }
      }
      if (guideExcerptIds.length !== new Set(guideExcerptIds).size) {
        errors.push("Guide excerpts must use globally unique IDs");
      }
    }
  }

  const componentsPath = at("components.json");
  if (isFile(componentsPath)) {
    const components = readJson(componentsPath) as Record<string, unknown>;
    if (components.style !== "radix-lyra") {
      errors.push("components.json must use the radix-lyra shadcn style");
    }
  }

  const diffFilesForMarkers = (): Array<Record<string, unknown>> =>
    data && Array.isArray(data.diffFiles) ? (data.diffFiles as Array<Record<string, unknown>>) : [];
  const hasGeneratedOrBinary = (): boolean =>
    diffFilesForMarkers().some((file) => file.generated || file.binary);

  const walkthroughComponents = at("src", "components", "walkthrough");
  const appSource = path.join(walkthroughComponents, "walkthrough-app.tsx");
  if (isFile(appSource)) {
    const markers = [
      "data-review-group-id",
      "data-file-path",
      "data-diff-path",
      "data-reviewed",
      "data-inline-evidence",
      "data-review-file-tree",
      "data-guide-document",
      "data-guide-phase-id",
      "data-guide-excerpt-id",
    ];
    if (isFile(dataPath) && hasGeneratedOrBinary()) {
      markers.push("data-generated", "data-generated-section");
    }
    const componentText = listFiles(walkthroughComponents, ".tsx")
      .map((componentPath) => readText(componentPath))
      .join("\n");
    for (const marker of markers) {
      if (!componentText.includes(marker)) {
        errors.push(`walkthrough components are missing ${marker}`);
      }
    }

    const reviewDocumentText = readText(path.join(walkthroughComponents, "review-document.tsx"));
    for (const marker of [
      "showGeneratedFiles",
      "changed-files-heading",
      "<ChangedFileTree",
      '"Show generated/binary"',
      '"Hide generated/binary"',
    ]) {
      if (!reviewDocumentText.includes(marker)) {
        errors.push(`review document is missing ${marker}`);
      }
    }
    if (
      reviewDocumentText.includes("Changed evidence") ||
      reviewDocumentText.includes("<Separator")
    ) {
      errors.push("Changed files must not use the removed evidence label or divider");
    }

    const changedFileTreeText = readText(path.join(walkthroughComponents, "changed-file-tree.tsx"));
    for (const marker of [
      "TREE_BORDER_WIDTH",
      "treeContentHeight + TREE_BORDER_WIDTH * 2",
      "treeCss(files)",
      'data-item-section="content"',
      "opacity: 0.5",
    ]) {
      if (!changedFileTreeText.includes(marker)) {
        errors.push(`changed file Tree is missing ${marker}`);
      }
    }
    if (changedFileTreeText.includes("paddingBlock")) {
      errors.push("changed file Tree must not add block padding");
    }

    const sidebarText = readText(path.join(walkthroughComponents, "review-context-sidebar.tsx"));
    for (const removedMarker of ["<ChangedFileTree", "tests-heading", "generated-files-heading"]) {
      if (sidebarText.includes(removedMarker)) {
        errors.push(`supporting evidence still contains removed section marker: ${removedMarker}`);
      }
    }

    const reviewGroupRailText = readText(path.join(walkthroughComponents, "review-group-rail.tsx"));
    for (const removedMarker of [">Active</Badge>", 'Circle className="fill-current"']) {
      if (reviewGroupRailText.includes(removedMarker)) {
        errors.push(
          `review group rail still contains removed Active chip marker: ${removedMarker}`,
        );
      }
    }
    if (!reviewGroupRailText.includes('Badge className="rounded-md border-')) {
      errors.push("review group Reviewed badge is missing the shared rounded-md radius");
    }

    const walkthroughAppText = readText(path.join(walkthroughComponents, "walkthrough-app.tsx"));
    if (!walkthroughAppText.includes('Button asChild className="shrink-0 rounded-md"')) {
      errors.push("Open PR is missing the shared rounded-md radius");
    }
    for (const marker of [
      "window.localStorage.getItem",
      "window.localStorage.setItem",
      "walkthroughData.meta.headSha",
      "reviewedExcerptIds",
      "countsTowardCompletion",
      "persistenceState",
      "resetUnreadableProgress",
      "copyProgressBackup",
    ]) {
      if (!walkthroughAppText.includes(marker)) {
        errors.push(`walkthrough progress persistence is missing ${marker}`);
      }
    }

    for (const marker of [
      ">Normal</TabsTrigger>",
      ">Guide</TabsTrigger>",
      "code hunks reviewed",
      "<GuideDocument",
    ]) {
      if (!reviewDocumentText.includes(marker)) {
        errors.push(`review modes are missing ${marker}`);
      }
    }

    const guideDiagramText = readText(path.join(walkthroughComponents, "guide-diagram.tsx"));
    for (const marker of [
      "ReactFlow",
      "fitView",
      "nodesDraggable={false}",
      "nodesConnectable={false}",
    ]) {
      if (!guideDiagramText.includes(marker)) {
        errors.push(`read-only Guide diagram is missing ${marker}`);
      }
    }

    const guideDocumentText = readText(path.join(walkthroughComponents, "guide-document.tsx"));
    for (const marker of [
      "Guide outline",
      "lineAnnotations",
      "renderAnnotation",
      "countsTowardCompletion",
    ]) {
      if (!guideDocumentText.includes(marker)) {
        errors.push(`Guide document is missing ${marker}`);
      }
    }

    for (const marker of [
      "shrink-0 rounded-md",
      'className="rounded-l-md! rounded-r-none!"',
      'className="rounded-l-none! rounded-r-md!"',
    ]) {
      if (!reviewDocumentText.includes(marker)) {
        errors.push(`review controls are missing rounded-corner treatment: ${marker}`);
      }
    }
    for (const marker of [
      "border-[var(--added)]/50!",
      "bg-[var(--added)]/10!",
      'Check className="text-[var(--added)]"',
    ]) {
      if (!reviewDocumentText.includes(marker)) {
        errors.push(`group reviewed control is missing selected-state treatment: ${marker}`);
      }
    }

    const sourceDiffText = readText(path.join(walkthroughComponents, "source-diff.tsx"));
    for (const marker of [
      "REVIEW_SURFACE_CLASS",
      "paddingBottom: 0",
      "metrics={DIFF_METRICS}",
      "handleDiffClick",
      'hasAttribute("data-diffs-header")',
      "event.stopPropagation()",
      "if (pressed && expanded) onToggleExpanded()",
      "onExpandedPathChange(path, !expandedPaths.has(path))",
    ]) {
      if (!sourceDiffText.includes(marker)) {
        errors.push(`source diff is missing ${marker}`);
      }
    }

    const diffOptionsText = readText(path.join(walkthroughComponents, "diff-options.ts"));
    for (const marker of ['[data-change-icon="change"]', "--diffs-warning-dark"]) {
      if (!diffOptionsText.includes(marker)) {
        errors.push(`diff options are missing modified-file styling: ${marker}`);
      }
    }

    const themeText = readText(at("src", "app", "globals.css"));
    for (const marker of ["--changed:", "--trees-git-modified-color-override: var(--changed)"]) {
      if (!themeText.includes(marker)) {
        errors.push(`walkthrough theme is missing modified-file styling: ${marker}`);
      }
    }
  }

  if (built) {
    const indexPath = at("out", "index.html");
    if (!isFile(indexPath)) {
      errors.push("missing static export out/index.html");
    } else {
      if (
        sourceFiles.length > 0 &&
        modifiedSeconds(indexPath) < Math.max(...sourceFiles.map(modifiedSeconds))
      ) {
        errors.push("static export is older than canonical MDX");
      }
      if (isFile(dataPath) && modifiedSeconds(indexPath) < modifiedSeconds(dataPath)) {
        errors.push("static export is older than generated walkthrough data");
      }
      const html = readText(indexPath);
      if (html.includes('src="/_next/')) {
        errors.push("static export uses root-relative assets");
      }
      if (collectFiles(at("out"), ".woff2").length > 0) {
        errors.push("static export must not bundle font binaries");
      }
      const builtText = `${html}\n${listFiles(at("out", "_next", "static", "chunks"), ".js")
        .map((chunkPath) => readTextLossy(chunkPath))
        .join("\n")}`;
      const labels = [
        "Changes in PR",
        "Mark Normal + Guide reviewed",
        "Open review groups",
        "Go to top",
        "Changed files",
        "Section ",
        "Normal",
        "Guide",
        "Guide outline",
        "code hunks reviewed",
      ];
      if (isFile(dataPath) && hasGeneratedOrBinary()) {
        labels.push("Show generated/binary");
      }
      for (const label of labels) {
        if (!builtText.includes(label)) errors.push(`static export is missing ${label}`);
      }
      if (builtText.includes("Open evidence")) {
        errors.push("responsive evidence must be inline, not a second drawer");
      }
      if (builtText.includes("Evidence and context")) {
        errors.push("supporting sections must not use an Evidence and context wrapper");
      }
      if (builtText.includes("Changed evidence")) {
        errors.push("static export must use Changed files instead of Changed evidence");
      }
      if (builtText.includes("Go to bottom")) {
        errors.push("static export must not contain a Go to bottom action");
      }
      for (const removedLabel of ["Active objective", "Browse all files", "data-lens-id"]) {
        if (builtText.includes(removedLabel)) {
          errors.push(`static export still contains removed walkthrough UI: ${removedLabel}`);
        }
      }
      for (const removedMarker of ["Context lens", "View all"]) {
        if (builtText.includes(removedMarker)) {
          errors.push(`static export still contains removed walkthrough marker: ${removedMarker}`);
        }
      }
      for (const emptyLabel of [
        "No focused tests",
        "No related evidence",
        "No relationship view",
        "No review notes",
      ]) {
        if (builtText.includes(emptyLabel)) {
          errors.push(`static export must omit empty section state: ${emptyLabel}`);
        }
      }
      if (builtText.includes("Open file on GitHub") || builtText.includes("Review note for")) {
        errors.push("Pierre file headers must not add external-link or information-icon controls");
      }
    }
  }

  if (errors.length > 0) {
    for (const error of errors) process.stdout.write(`ERROR: ${error}\n`);
    return 1;
  }

  process.stdout.write("Template validation passed.\n");
  return 0;
}

process.exit(main(process.argv.slice(2)));
