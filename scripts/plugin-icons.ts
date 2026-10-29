import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePlugins } from "./plugin-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Original plugin marks share BB's 24-unit grid, 1.5-unit strokes and rounded
// caps/joins. Keep one geometry per plugin for compact, light and dark assets.
const customIcons = new Map<string, { name: string; body: string }>([
  [
    "agent-instructions",
    {
      name: "Agent instructions",
      body: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M7 8h3m4 0h3M7 16h7m3 0h.01"/><circle cx="12" cy="8" r="2"/><circle cx="16" cy="16" r="2"/>',
    },
  ],
  [
    "agentation",
    {
      name: "Agentation",
      body: '<path d="M8 3H16c4 0 5 1 5 5v5c0 4-1 5-5 5h-3l-5 4v-4c-4 0-5-1-5-5V8c0-4 1-5 5-5Z"/><circle cx="12" cy="10.5" r="3"/><path d="M12 6v2M12 13v2m-4.5-4.5h2m5 0h2"/>',
    },
  ],
  [
    "amp",
    {
      name: "Amp",
      body: '<path d="M5 18 10.5 5h3L19 18M7.5 12h9M3 21h18"/><path d="m12 8-2 5h4l-2 5"/>',
    },
  ],
  [
    "at-plugin",
    { name: "Installed Plugin Mentions", body: '<path d="M9 3 6 21M18 3l-3 18M3 9h18M2 15h18"/>' },
  ],
  [
    "boat-sandbox",
    {
      name: "Boat Sandbox [Experimental]",
      body: '<path d="M3 14h18l-2.5 5h-13zM7 14V8h10v6M12 3v5M9 5h6M2 22c2 0 2-1.5 4-1.5S8 22 10 22s2-1.5 4-1.5 2 1.5 4 1.5 2-1.5 4-1.5"/>',
    },
  ],
  [
    "code-review",
    {
      name: "Review",
      body: '<path d="M10 3H7C4.5 3 4 3.5 4 6v12c0 2.5.5 3 3 3h10c2.5 0 3-.5 3-3v-4M8 8h3M8 12h2M8 16h3"/><circle cx="17" cy="6" r="4"/><path d="m20 9 2 2m-7-5 1.5 1.5L19 5"/>',
    },
  ],
  [
    "devin",
    {
      name: "Devin",
      body: '<path d="M5 15V8c0-3.5 14-3.5 14 0v7M5 9h14M9 13h.01M15 13h.01M9 17h6M3 11v4M21 11v4M5 15c0 4 2 6 7 6s7-2 7-6M12 3V1.5"/>',
    },
  ],
  [
    "dotfiles",
    {
      name: "Dotfiles",
      body: '<path d="M8 6 5 3H3v18h14v-6M8 6h9v5M3 9h7"/><path d="m17 10-3 4 3 4m3-8 3 4-3 4"/><circle cx="7" cy="17" r=".75"/>',
    },
  ],
  [
    "gcp-machine",
    {
      name: "GCP Machine",
      body: '<path d="M6 11a4 4 0 0 1 0-8 5 5 0 0 1 8 1 3.5 3.5 0 1 1 4 7"/><rect x="5" y="14" width="14" height="7" rx="2"/><path d="M8 17.5h.01M11 17.5h5M12 10v4"/>',
    },
  ],
  [
    "genui",
    {
      name: "Generative UI",
      body: '<rect x="3" y="8" width="18" height="13" rx="3"/><path d="M3 13h18M9 13v8m7-19 .8 3.2L20 6l-3.2.8L16 10l-.8-3.2L12 6l3.2-.8z"/>',
    },
  ],
  [
    "gh-stack",
    {
      name: "GitHub Stack",
      body: '<circle cx="6" cy="4" r="2"/><circle cx="18" cy="4" r="2"/><path d="M6 6v5M18 6v1c0 3-12 1-12 4M3 12l9 4 9-4M3 16l9 4 9-4M3 20l9 3 9-3"/>',
    },
  ],
  [
    "gitbutler",
    {
      name: "GitButler",
      body: '<circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="4" r="2"/><path d="M6 6v12M18 6v2c0 4-12 4-12 8M3 10l3 2 3-2"/>',
    },
  ],
  [
    "gtd-sidebar",
    {
      name: "GTD Sidebar",
      body: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 3v18m3-13 1.5 1.5L17 6m-5 8 1.5 1.5L17 12M5.5 7h1M5.5 12h1M5.5 17h1"/>',
    },
  ],
  [
    "html",
    {
      name: "HTML visualizations",
      body: '<rect x="2" y="4" width="20" height="16" rx="3"/><path d="M2 8h20m-13 4-3 2 3 2m6-4 3 2-3 2m-2-5-2 6M5 6h.01M8 6h.01"/>',
    },
  ],
  [
    "kitchen-sink",
    {
      name: "Kitchen Sink",
      body: '<path d="M3 12h18v3c0 4-2 6-6 6H9c-4 0-6-2-6-6zM2 12h20M8 8V6a4 4 0 0 1 8 0v2M14 8h4M6 15h12"/>',
    },
  ],
  [
    "magic-compose",
    {
      name: "Magic Compose",
      body: '<path d="m4 20 10-10 4 4L8 24z" transform="translate(0 -3)"/><path d="m12 9 4 4M6 2v4M4 4h4M20 2v6M17 5h6M20 17v4M18 19h4"/>',
    },
  ],
  [
    "monokai",
    {
      name: "bb Monokai",
      body: '<path d="M12 3C6.5 3 2 7 2 12s4 9 9 9c2 0 3-1.5 2-3s0-3 2-3h3c3 0 4-2 4-4 0-4.5-4.5-8-10-8Z"/><circle cx="7" cy="10" r="1"/><circle cx="11" cy="7" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="6" cy="15" r="1"/>',
    },
  ],
  [
    "scott-docs",
    {
      name: "Docs",
      body: '<path d="M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15M5 8c1.5-.3 2.5-.1 4 .5M5 12c1.5-.3 2.5-.1 4 .5M15 8.5c1.5-.6 2.5-.8 4-.5M15 12.5c1.5-.6 2.5-.8 4-.5"/>',
    },
  ],
  [
    "scott-tasks",
    {
      name: "Tasks",
      body: '<rect x="3" y="5" width="18" height="16" rx="3"/><rect x="8" y="2" width="8" height="6" rx="2"/><path d="m7 14 3 3 7-6"/>',
    },
  ],
  [
    "slopcop",
    {
      name: "SlopCop",
      body: '<path d="M12 2 3 6v6c0 5 5 8 9 10 4-2 9-5 9-10V6zM8 10h8M12 6v8M7 17l3-3h4l3 3"/>',
    },
  ],
  [
    "t3-composer",
    {
      name: "T3 Composer",
      body: '<path d="M18 3H6C3 3 2 4 2 7v7c0 3 1 4 4 4h2v4l5-4h5c3 0 4-1 4-4V7c0-3-1-4-4-4Z"/><path d="M6 8h5M8.5 8v6M15 8h3l-2 3c3-1 4 4 0 3h-1"/>',
    },
  ],
  [
    "traces",
    {
      name: "Traces",
      body: '<path d="M4 3v15c0 2 .5 3 3 3h14M4 7h5l2 5h5M4 16h4l2-4M16 12l3-7"/><circle cx="19" cy="5" r="2"/><circle cx="17" cy="16" r="2"/><path d="m18.5 17.5 3 3"/>',
    },
  ],
  [
    "usage-bar",
    {
      name: "Usage Bar",
      body: '<path d="M3 16a9 9 0 1 1 18 0M5 21h14M12 13l4-5M5 11l1.5.5M8 6l1 1.5M16 6l-1 1.5M19 11l-1.5.5"/><circle cx="12" cy="15" r="2"/>',
    },
  ],
  [
    "vimium",
    {
      name: "Vimium",
      body: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="m8 9 4 6 4-6M5 9h.01M19 9h.01M5 15h.01M19 15h.01M9 22h6"/>',
    },
  ],
  [
    "whiteboard",
    {
      name: "Whiteboard",
      body: '<rect x="2" y="3" width="20" height="14" rx="3"/><path d="M12 17v5M8 22l4-3 4 3M7 8h4v4H7zM11 10h3l3-3M14 10l3 3"/>',
    },
  ],
]);

function svg(body: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" color="${color}">\n  <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">\n    ${body}\n  </g>\n</svg>\n`;
}

function expectedFiles(plugin: string, body: string): Map<string, string> {
  const directory = join(ROOT, "plugins", plugin, "assets");
  return new Map([
    [join(directory, "icon.svg"), svg(body, "#767676")],
    [join(directory, "logo.svg"), svg(body, "oklch(44% 0 0)")],
    [join(directory, "logo-dark.svg"), svg(body, "oklch(72% 0 0)")],
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
  if (!customIcons.has(directory)) {
    errors.push(`plugins/${directory}: no entry in customIcons in scripts/plugin-icons.ts`);
  }
}

for (const [plugin, { name, body }] of customIcons) {
  errors.push(...(await validateManifest(plugin, "./assets/icon.svg")));
  for (const [path, expected] of expectedFiles(plugin, body)) {
    if (check) {
      const actual = existsSync(path) ? await readFile(path, "utf8") : "";
      if (actual !== expected) errors.push(`${path}: not generated by scripts/plugin-icons.ts`);
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, expected);
    }
  }
  console.log(`${plugin.padEnd(16)} ${name}`);
}

if (errors.length > 0) {
  console.error(`\n${errors.join("\n")}`);
  process.exit(1);
}

console.log(
  `\n${check ? "Checked manifests and generated bytes" : "Generated plugin icons"} using BB's rounded 24px outline style.`,
);
