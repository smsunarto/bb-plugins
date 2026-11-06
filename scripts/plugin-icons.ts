import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workspacePlugins } from "./plugin-package";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Preserve the committed artwork across compact, light and dark assets.
// Outline marks use a 24-unit grid; Devin uses its official solid 425-unit mark.
const customIcons = new Map<string, { name: string; body: string; solid?: boolean }>([
  [
    "agent-instructions",
    {
      name: "Agent instructions",
      body: '<path d="M15 12h-5m5-4h-5m9 9V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    },
  ],
  [
    "agentation",
    {
      name: "Agentation",
      body: '<path d="M14 4.1L12 6M5.1 8l-2.9-.8M6 12l-1.9 2M7.2 2.2L8 5.1m1.037 4.59a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z"/>',
    },
  ],
  [
    "at-plugin",
    { name: "Installed Plugin Mentions", body: '<path d="M4 9h16M4 15h16M10 3L8 21m8-18l-2 18"/>' },
  ],
  [
    "boat-sandbox",
    {
      name: "Boat Sandbox [Experimental]",
      body: '<path d="M10 2v15m-3 5a4 4 0 0 1-4-4a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1a4 4 0 0 1-4 4zM9.159 2.46a1 1 0 0 1 1.521-.193l9.977 8.98A1 1 0 0 1 20 13H4a1 1 0 0 1-.824-1.567z"/>',
    },
  ],
  [
    "code-review",
    {
      name: "Review",
      body: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7M6 9v12"/>',
    },
  ],
  [
    "devin",
    {
      name: "Devin",
      body: '<path d="M70 159.333V91.3471C70 88.3592 71.594 85.5983 74.1816 84.1044L133.043 50.1205C135.631 48.6265 138.819 48.6265 141.407 50.1205L200.269 84.1044C202.856 85.5983 204.45 88.3592 204.45 91.3471V126.068C204.708 137.606 210.806 148.734 221.531 154.926C232.256 161.117 244.942 160.834 255.063 155.289L285.132 137.929C287.719 136.435 290.907 136.435 293.495 137.929L352.357 171.913C354.944 173.406 356.538 176.167 356.538 179.155V247.123C356.538 250.111 354.944 252.872 352.357 254.366L293.495 288.35C290.907 289.844 287.719 289.844 285.132 288.35L255.306 271.13C245.146 265.456 232.344 265.117 221.534 271.358C210.809 277.55 204.711 288.678 204.453 300.215V334.926C204.453 337.914 202.859 340.675 200.271 342.169L141.41 376.153C138.822 377.647 135.634 377.647 133.046 376.153L74.1845 342.169C71.5969 340.675 70.0028 337.914 70.0028 334.926V266.959C70.0029 263.971 71.5969 261.21 74.1845 259.716L133.046 225.732C135.634 224.238 138.822 224.238 141.41 225.732L171.547 243.132C181.656 248.638 194.306 248.906 205.005 242.729C215.815 236.488 221.922 225.231 222.088 213.595C221.83 202.057 215.732 189.737 205.008 183.545C194.283 177.353 181.597 177.636 171.476 183.181L141.269 200.72C138.67 202.229 135.461 202.228 132.864 200.716L74.1576 166.562C71.5835 165.065 70 162.311 70 159.333Z"/>',
      solid: true,
    },
  ],
  [
    "dotfiles",
    {
      name: "Dotfiles",
      body: '<path d="M10.3 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.98a2 2 0 0 1 1.69.9l.66 1.2A2 2 0 0 0 12 6h8a2 2 0 0 1 2 2v3.3m-7.695 8.23l.923-.382m0-2.296l-.923-.383m2.547-1.241l-.383-.923m.383 6.467l-.383.924m2.679-6.468l.383-.923m-.001 7.391l-.382-.924m1.624-3.92l.924-.383m-.924 2.679l.924.383"/><circle cx="18" cy="18" r="3"/>',
    },
  ],
  [
    "gcp-machine",
    {
      name: "GCP Machine",
      body: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><path d="M6 6h.01M6 18h.01"/>',
    },
  ],
  [
    "genui",
    {
      name: "Generative UI",
      body: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M10 4v4M2 8h20M6 4v4"/>',
    },
  ],
  [
    "gh-stack",
    {
      name: "GitHub Stack",
      body: '<path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z"/><path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12"/><path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17"/>',
    },
  ],
  [
    "gitbutler",
    {
      name: "GitButler",
      body: '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
    },
  ],
  [
    "gtd-sidebar",
    {
      name: "GTD Sidebar",
      body: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    },
  ],
  [
    "html",
    {
      name: "HTML visualizations",
      body: '<path d="m18 16l4-4l-4-4M6 8l-4 4l4 4m8.5-12l-5 16"/>',
    },
  ],
  [
    "kitchen-sink",
    {
      name: "Kitchen Sink",
      body: '<path d="M2 12h20m-2 0v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8m0-4l16-4M8.86 6.78l-.45-1.81a2 2 0 0 1 1.45-2.43l1.94-.48a2 2 0 0 1 2.43 1.46l.45 1.8"/>',
    },
  ],
  [
    "magic-compose",
    {
      name: "Magic Compose",
      body: '<path d="m21.64 3.64l-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72M14 7l3 3M5 6v4m14 4v4M10 2v2M7 8H3m18 8h-4M11 3H9"/>',
    },
  ],
  [
    "monokai",
    {
      name: "bb Monokai",
      body: '<path d="M12 22a1 1 0 0 1 0-20a10 9 0 0 1 10 9a5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z"/><circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/>',
    },
  ],
  [
    "scott-docs",
    {
      name: "Docs",
      body: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/>',
    },
  ],
  [
    "scott-tasks",
    {
      name: "Tasks",
      body: '<path d="M13 5h8m-8 7h8m-8 7h8M3 17l2 2l4-4"/><rect width="6" height="6" x="3" y="4" rx="1"/>',
    },
  ],
  [
    "slopcop",
    {
      name: "SlopCop",
      body: '<path d="M7 18v-6a5 5 0 1 1 10 0v6M5 21a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-1a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2zm16-9h1m-3.5-7.5L18 5M2 12h1m9-10v1M4.929 4.929l.707.707M12 12v6"/>',
    },
  ],
  [
    "neatlogs",
    {
      name: "Neatlogs",
      body: '<path d="M4 4v16h16"/><path d="M8 7h6M10 11h8M12 15h5"/>',
    },
  ],
  [
    "t3-composer",
    {
      name: "T3 Composer",
      body: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/>',
    },
  ],
  [
    "traces",
    {
      name: "Traces",
      body: '<path d="m10.586 5.414l-5.172 5.172m13.172 2.828l-5.172 5.172M6 12h12"/><circle cx="12" cy="20" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="20" cy="12" r="2"/><circle cx="4" cy="12" r="2"/>',
    },
  ],
  [
    "usage-bar",
    {
      name: "Usage Bar",
      body: '<path d="m12 14l4-4M3.34 19a10 10 0 1 1 17.32 0"/>',
    },
  ],
  [
    "vimium",
    {
      name: "Vimium",
      body: '<path d="M10 8h.01M12 12h.01M14 8h.01M16 12h.01M18 8h.01M6 8h.01M7 16h10m-9-4h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
    },
  ],
  [
    "whiteboard",
    {
      name: "Whiteboard",
      body: '<path d="M2 3h20m-1 0v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3m4 18l5-5l5 5"/>',
    },
  ],
]);

function svg(body: string, color: string, solid: boolean): string {
  if (solid)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 425 425" fill="currentColor" color="${color}">\n  ${body}\n</svg>\n`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" color="${color}">\n  <g stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">\n    ${body}\n  </g>\n</svg>\n`;
}

function expectedFiles(plugin: string, body: string, solid: boolean): Map<string, string> {
  const directory = join(ROOT, "plugins", plugin, "assets");
  return new Map([
    [join(directory, "icon.svg"), svg(body, "#767676", solid)],
    [join(directory, "logo.svg"), svg(body, "oklch(44% 0 0)", solid)],
    [join(directory, "logo-dark.svg"), svg(body, "oklch(72% 0 0)", solid)],
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

for (const [plugin, { name, body, solid = false }] of customIcons) {
  errors.push(...(await validateManifest(plugin, "./assets/icon.svg")));
  for (const [path, expected] of expectedFiles(plugin, body, solid)) {
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
