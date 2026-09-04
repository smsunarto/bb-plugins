import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ActivitySparkIcon,
  ArtboardIcon,
  BellIcon,
  ChatFeedbackIcon,
  ComputerScreenShareIcon,
  Doc01Icon,
  KeyboardIcon,
  KitchenUtensilsIcon,
  Layers01Icon,
  PanelLeftIcon,
  ServerStack01Icon,
  Settings01Icon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { workspacePlugins } from "./plugin-package";
import { AMP_LOGO_PATHS, AMP_LOGO_VIEW_BOX } from "../plugins/amp/src/amp-brand";

// Keyed by DIRECTORY under plugins/, which scripts/plugin-package.test.ts pins
// to the plugin id bb derives from the package name. Anchored to the repo root
// so the script works from any working directory.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

// BB 0.35's plugin icon registry uses Hugeicons nodes. In the Plugins page,
// the container is 24px and the named glyph is 20px. Compact sidebar icons are
// 16px with no inner scale. Keep the package version pinned in package.json.
const settingsScale = 20 / 24;
const settingsOffset = (24 - 24 * settingsScale) / 2;
const themeColors = {
  light: "oklch(44% 0 0)",
  dark: "oklch(78% 0 0)",
} as const;
// BB paints installed compact assets as currentColor masks, and bb 0.40 does
// the same for marketplace SVGs. BB 0.39 renders marketplace SVGs as images,
// so use a neutral fallback that stays visible on both light and dark cards.
const compactFallbackColor = "#767676";
// A filled brand mark needs flat hex, not the stroked glyphs' currentColor.
const brandColors = { light: "#666666", dark: "#B8B8B8" } as const;

type IconNode = readonly [string, Record<string, string | number>];

// BB-local icon from bb-app@0.35.1 (desktop-v0.35.1,
// 9f4bea88dd6c7c611f4e5205a6f23b7bbaa3707f). Hugeicons free has no suitable
// artist-palette glyph, so BB's plugin registry defines this node itself.
const paletteIcon: readonly IconNode[] = [
  [
    "path",
    {
      d: "M21.8205 10.4127C22.062 11.8519 22.1827 12.5715 21.2423 13.9326C21.1459 14.0722 20.8966 14.3713 20.777 14.4911C19.6103 15.6586 18.4308 15.6586 16.0716 15.6586H14.1392C13.5085 15.6586 13.1931 15.6586 12.9639 15.7142C11.9586 15.9581 11.3031 16.9391 11.453 17.9755C11.4872 18.2118 11.6043 18.5085 11.8386 19.102C11.9345 19.3449 11.9824 19.4664 12.0136 19.7304C12.1292 20.7084 11.0869 21.9508 10.1158 21.9926C9.85358 22.0039 9.83681 22.0002 9.80326 21.9926C7.66174 21.51 5.66204 20.3123 4.18389 18.4421C0.736789 14.0808 1.43146 7.71364 5.73548 4.22064C10.0395 0.727643 16.323 1.43156 19.7701 5.79289C20.868 7.1819 21.5457 8.77438 21.8205 10.4127Z",
      fill: "none",
      fillRule: "evenodd",
      clipRule: "evenodd",
      stroke: "currentColor",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "M7.36719 7.74976H7.24219M7.49219 7.74976C7.49219 7.88783 7.38026 7.99976 7.24219 7.99976C7.10412 7.99976 6.99219 7.88783 6.99219 7.74976C6.99219 7.61169 7.10412 7.49976 7.24219 7.49976C7.38026 7.49976 7.49219 7.61169 7.49219 7.74976Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "1",
    },
  ],
  [
    "path",
    {
      d: "M7.36719 15.7498H7.24219M7.49219 15.7498C7.49219 15.8878 7.38026 15.9998 7.24219 15.9998C7.10412 15.9998 6.99219 15.8878 6.99219 15.7498C6.99219 15.6117 7.10412 15.4998 7.24219 15.4998C7.38026 15.4998 7.49219 15.6117 7.49219 15.7498Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "2",
    },
  ],
  [
    "path",
    {
      d: "M11.8672 5.74976H11.7422M11.9922 5.74976C11.9922 5.88783 11.8803 5.99976 11.7422 5.99976C11.6041 5.99976 11.4922 5.88783 11.4922 5.74976C11.4922 5.61169 11.6041 5.49976 11.7422 5.49976C11.8803 5.49976 11.9922 5.61169 11.9922 5.74976Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "3",
    },
  ],
  [
    "path",
    {
      d: "M16.3672 7.74976H16.2422M16.4922 7.74976C16.4922 7.88783 16.3803 7.99976 16.2422 7.99976C16.1041 7.99976 15.9922 7.88783 15.9922 7.74976C15.9922 7.61169 16.1041 7.49976 16.2422 7.49976C16.3803 7.49976 16.4922 7.61169 16.4922 7.74976Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "4",
    },
  ],
  [
    "path",
    {
      d: "M18.3672 11.7498H18.2422M18.4922 11.7498C18.4922 11.8878 18.3803 11.9998 18.2422 11.9998C18.1041 11.9998 17.9922 11.8878 17.9922 11.7498C17.9922 11.6117 18.1041 11.4998 18.2422 11.4998C18.3803 11.4998 18.4922 11.6117 18.4922 11.7498Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "5",
    },
  ],
  [
    "path",
    {
      d: "M5.86719 11.7498H5.74219M5.99219 11.7498C5.99219 11.8878 5.88026 11.9998 5.74219 11.9998C5.60412 11.9998 5.49219 11.8878 5.49219 11.7498C5.49219 11.6117 5.60412 11.4998 5.74219 11.4998C5.88026 11.4998 5.99219 11.6117 5.99219 11.7498Z",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: "1.5",
      key: "6",
    },
  ],
];

const nanocodexIcon: readonly IconNode[] = [
  [
    "path",
    {
      d: "M5 5h14v14H5z",
      stroke: "currentColor",
      strokeWidth: "2",
      key: "0",
    },
  ],
  [
    "path",
    {
      d: "m8 9 2 2-2 2m4 0h4",
      stroke: "currentColor",
      strokeWidth: "2",
      key: "1",
    },
  ],
];

const customIcons = {
  "agent-proxy": {
    name: "Server",
    nodes: ServerStack01Icon,
  },
  agentation: {
    name: "ChatFeedback",
    nodes: ChatFeedbackIcon,
  },
  canvas: {
    name: "Artboard",
    nodes: ArtboardIcon,
  },
  // Amp ships its own wordmark glyph, so this entry renders Sourcegraph's mark
  // rather than a stand-in from the icon set. `src/amp-brand.ts` is the single
  // source for those paths — the plugin writes the same art into bb's config.
  amp: {
    name: "Amp (brand mark)",
    brand: { paths: AMP_LOGO_PATHS, viewBox: AMP_LOGO_VIEW_BOX },
  },
  docs: {
    name: "Doc",
    nodes: Doc01Icon,
  },
  dotfiles: {
    name: "Settings",
    nodes: Settings01Icon,
  },
  "gh-stack": {
    name: "Layers",
    nodes: Layers01Icon,
  },
  notify: {
    name: "Bell",
    nodes: BellIcon,
  },
  novnc: {
    name: "ComputerScreenShare",
    nodes: ComputerScreenShareIcon,
  },
  "smart-embeds": {
    name: "SourceCode",
    nodes: SourceCodeIcon,
  },
  vimium: {
    name: "Keyboard",
    nodes: KeyboardIcon,
  },
  "kitchen-sink": {
    name: "KitchenUtensils",
    nodes: KitchenUtensilsIcon,
  },
  // Upstream t3sidebar, which this plugin was forked from, declares BB's named
  // "PanelLeft" icon; Hugeicons ships the same glyph, so the rename keeps that
  // identity through this pipeline.
  "gtd-sidebar": {
    name: "PanelLeft",
    nodes: PanelLeftIcon,
  },
  "agent-trace": {
    name: "ActivitySpark",
    nodes: ActivitySparkIcon,
  },
  nanocodex: {
    name: "Terminal",
    nodes: nanocodexIcon,
  },
  monokai: {
    name: "Palette",
    nodes: paletteIcon,
  },
} as const;

type CustomPlugin = keyof typeof customIcons;

function serializeNode([tag, properties]: IconNode): string {
  const attributes = Object.entries(properties)
    .filter(([name]) => name !== "key")
    .map(([name, value]) => {
      const attribute = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      return `${attribute}="${value}"`;
    })
    .join(" ");
  return `<${tag} ${attributes}/>`;
}

function brandSvg(brand: { paths: readonly string[]; viewBox: string }, color: string): string {
  // Same shape as the glyph output: the colour lives on the <svg>, the artwork
  // refers to it, so a host can retint the mark without rewriting paths.
  const artwork = brand.paths.map((d) => `  <path d="${d}" fill="currentColor"/>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${brand.viewBox}" color="${color}">\n${artwork}\n</svg>\n`;
}

function svg(sourceNodes: readonly IconNode[], color: string, settings: boolean): string {
  const nodes = sourceNodes.map(serializeNode);
  const body = nodes.map((node) => `  ${node}`).join("\n");
  const artwork = settings
    ? `  <g transform="translate(${settingsOffset} ${settingsOffset}) scale(${settingsScale})">\n${nodes.map((node) => `    ${node}`).join("\n")}\n  </g>`
    : body;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" color="${color}">\n${artwork}\n</svg>\n`;
}

async function expectedFiles(plugin: CustomPlugin): Promise<Map<string, string>> {
  const entry = customIcons[plugin] as {
    nodes?: readonly IconNode[];
    brand?: { paths: readonly string[]; viewBox: string };
  };
  const directory = join(ROOT, "plugins", plugin, "assets");
  if (entry.brand !== undefined) {
    const { brand } = entry;
    return new Map([
      [join(directory, "icon.svg"), brandSvg(brand, compactFallbackColor)],
      [join(directory, "logo.svg"), brandSvg(brand, brandColors.light)],
      [join(directory, "logo-dark.svg"), brandSvg(brand, brandColors.dark)],
    ]);
  }
  const nodes = entry.nodes as readonly IconNode[];
  return new Map([
    [join(directory, "icon.svg"), svg(nodes, compactFallbackColor, false)],
    [join(directory, "logo.svg"), svg(nodes, themeColors.light, true)],
    [join(directory, "logo-dark.svg"), svg(nodes, themeColors.dark, true)],
  ]);
}

async function validateManifest(plugin: string, expectedIcon: string): Promise<string[]> {
  const path = join(ROOT, "plugins", plugin, "package.json");
  if (!existsSync(path)) return [`Missing ${path}`];
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const branding = manifest.bb?.branding;
  const errors: string[] = [];
  if (branding?.icon !== expectedIcon) {
    errors.push(`${path}: expected branding.icon ${JSON.stringify(expectedIcon)}`);
  }
  if (
    expectedIcon.startsWith(".") &&
    (branding?.logo?.light !== "./assets/logo.svg" ||
      branding?.logo?.dark !== "./assets/logo-dark.svg")
  ) {
    errors.push(`${path}: expected light and dark settings logos`);
  }
  return errors;
}

const check = process.argv.includes("--check");
const errors: string[] = [];

// A plugin added without an entry above would keep whatever art it was born
// with, and nothing else here would notice.
for (const { directory } of workspacePlugins(ROOT)) {
  if (!(directory in customIcons)) {
    errors.push(`plugins/${directory}: no entry in customIcons in scripts/plugin-icons.ts`);
  }
}

for (const plugin of Object.keys(customIcons) as CustomPlugin[]) {
  errors.push(...(await validateManifest(plugin, "./assets/icon.svg")));
  for (const [path, expected] of await expectedFiles(plugin)) {
    if (check) {
      const actual = existsSync(path) ? await readFile(path, "utf8") : "";
      if (actual !== expected) errors.push(`${path}: not generated by scripts/plugin-icons.ts`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, expected);
    }
  }
  console.log(`${plugin.padEnd(16)} ${customIcons[plugin].name}`);
}

if (errors.length > 0) {
  console.error(`\n${errors.join("\n")}`);
  process.exit(1);
}

console.log(
  `\n${check ? "Checked manifests and generated bytes" : "Generated plugin icons"} using BB's 20-in-24 settings layout and pinned Hugeicons nodes.`,
);
