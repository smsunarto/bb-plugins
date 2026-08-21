import { derivePluginID } from "./derive-plugin-id.ts";
import { wireName } from "./wire-name.ts";

/**
 * The scaffold templates behind `bb-kit create` (§7). One function, no
 * I/O: `scaffoldFiles(packageName)` returns every file as text, keyed by
 * its path inside the new plugin directory. `bin-create.ts` writes them;
 * tests assert on them directly.
 *
 * Every template uses the real published surfaces — @bb-kit/core
 * subpaths and the SDK — so a fresh scaffold typechecks and its tests
 * pass the moment devDependencies are installed.
 */

/**
 * Exact runtime pins (§7): `zod`, and the framework itself — bb loads
 * plugin source in place, so `@bb-kit/core` imports resolve at run time
 * and a devDependency pin would break an installed plugin.
 */
export const SCAFFOLD_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@bb-kit/core": "0.1.0",
  zod: "4.4.3",
};

/**
 * Exact devDependency pins (§7): the SDK and the SDK-testing
 * transitives (better-sqlite3/hono/cron-parser are imported at module
 * top by `@get-bb/plugin-sdk/testing`). @types/react is an OPTIONAL
 * peer of @testing-library/react, so npm will not auto-install it — it
 * must be explicit for `tsc` to see React's JSX types.
 */
export const SCAFFOLD_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  "@get-bb/plugin-sdk": "0.4.8",
  "@tanstack/react-query": "5.101.4",
  "@testing-library/react": "16.3.2",
  "@types/node": "22.20.1",
  "@types/react": "19.2.18",
  "better-sqlite3": "12.11.1",
  "cron-parser": "5.5.0",
  hono: "4.13.2",
  jsdom: "25.0.1",
  react: "19.2.8",
  "react-dom": "19.2.8",
  tsx: "4.23.12",
  typescript: "7.0.2",
};

function packageJson(name: string, id: string): string {
  return `${JSON.stringify(
    {
      name,
      version: "0.1.0",
      private: true,
      description: "A bb plugin.",
      type: "module",
      engines: { node: ">=22.19.0" },
      scripts: {
        check: "bb-kit check",
        test: "node --test --import tsx",
        typecheck: "tsc",
      },
      bb: {
        name: id,
        description: "A bb plugin.",
        server: "./server.ts",
        app: "./ui/app.tsx",
        branding: { icon: "./assets/icon.svg" },
        skills: [],
      },
      dependencies: SCAFFOLD_DEPENDENCIES,
      devDependencies: SCAFFOLD_DEV_DEPENDENCIES,
    },
    null,
    2,
  )}\n`;
}

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "es2023",
      lib: ["es2023", "dom", "dom.iterable"],
      module: "nodenext",
      moduleResolution: "nodenext",
      types: ["node"],
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      skipLibCheck: true,
    },
  },
  null,
  2,
)}\n`;

function serverTs(id: string): string {
  return [
    'import { definePlugin } from "@bb-kit/core/plugin";',
    'import { defineRPC, type ClientFor } from "@bb-kit/core/rpc";',
    'import { status } from "./cli/status.ts";',
    'import { ping } from "./rpc/ping.ts";',
    'import { createContext } from "./server/context.ts";',
    "",
    "export const rpc = defineRPC({",
    `  namespace: "${id}",`,
    "  procedures: { ping },",
    "});",
    "",
    "/** The contract type ui/rpc.ts and cli/ commands bind against. */",
    "export type RPC = typeof rpc;",
    "",
    "/** The full client type cli/ commands annotate (§2, §4). */",
    "export type Client = ClientFor<RPC>;",
    "",
    "export default definePlugin({",
    "  rpc,",
    `  cli: { summary: "${id} commands", commands: { status } },`,
    "  context: createContext,",
    "});",
    "",
  ].join("\n");
}

function serverTestTs(id: string): string {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";',
    'import plugin from "./server.ts";',
    "",
    'test("the plugin registers its RPC and CLI against the fake host", async () => {',
    `  const { bb, harness } = createFakePluginHost({ pluginId: "${id}" });`,
    "  await plugin(bb);",
    `  assert.deepEqual(await harness.callRpc("${wireName(id, "ping")}"), { pong: true });`,
    '  const status = await harness.runCli(["status"]);',
    "  assert.equal(status.exitCode, 0);",
    "  assert.match(status.stdout, /pong=true/);",
    "});",
    "",
  ].join("\n");
}

const SERVER_CONTEXT_TS = [
  'import type { BbPluginApi } from "@get-bb/plugin-sdk";',
  "",
  "/**",
  " * The one Context every handler annotates (§3). Grow it here — a",
  " * database handle, a config value — and every handler sees the change.",
  " */",
  "export type Context = {};",
  "",
  "export function createContext(_bb: BbPluginApi): Context {",
  "  return {};",
  "}",
  "",
].join("\n");

const RPC_PING_TS = [
  'import { defineQuery } from "@bb-kit/core/rpc";',
  'import { z } from "zod";',
  'import type { Context } from "../server/context.ts";',
  "",
  "/** The scaffold's example Query — replace it with your first real one. */",
  "export const ping = defineQuery({",
  "  output: z.object({ pong: z.boolean() }),",
  "  handler: (_context: Context) => ({ pong: true }),",
  "});",
  "",
].join("\n");

const RPC_PING_TEST_TS = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { ping } from "./ping.ts";',
  "",
  'test("ping answers pong", async () => {',
  "  assert.deepEqual(await ping.handler({}), { pong: true });",
  "});",
  "",
].join("\n");

const CLI_STATUS_TS = [
  'import { defineCommand } from "@bb-kit/core/cli";',
  'import type { Client } from "../server.ts";',
  "",
  "/** The scaffold's example command — replace it with your first real one. */",
  "export const status = defineCommand({",
  '  summary: "Show plugin status",',
  "  run: async (client: Client) => {",
  "    const result = await client.ping();",
  "    return { exitCode: 0, stdout: `pong=${result.pong}\\n` };",
  "  },",
  "});",
  "",
].join("\n");

const CLI_STATUS_TEST_TS = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import { invokeCLI } from "@bb-kit/core/cli";',
  'import { stubClient } from "@bb-kit/core/testing";',
  'import type { Client } from "../server.ts";',
  'import { status } from "./status.ts";',
  "",
  'test("status prints the ping result", async () => {',
  "  // stubClient fills the rest of Client with throwing stubs, so this",
  "  // test stays green as new procedures land.",
  "  const client = stubClient<Client>({ ping: async () => ({ pong: true }) });",
  '  const result = await invokeCLI({ status }, client, ["status"]);',
  '  assert.deepEqual(result, { exitCode: 0, stdout: "pong=true\\n" });',
  "});",
  "",
].join("\n");

function uiRPCTs(id: string): string {
  return [
    'import { createRPC } from "@bb-kit/core/query";',
    'import type { RPC } from "../server.ts";',
    "",
    "/** The namespace, written ONCE in ui/ (§5) — import `rpc` everywhere. */",
    "// Single-argument useQuery(x) treats x as procedure input unless every",
    "// key of x is a TanStack option name; use useQuery(input, {}) to force",
    "// the input reading when that heuristic could misfire.",
    `export const rpc = createRPC<RPC>("${id}");`,
    "",
  ].join("\n");
}

function uiAppTsx(id: string): string {
  return [
    'import { PluginQueryBoundary } from "@bb-kit/core/query";',
    'import { definePluginApp } from "@get-bb/plugin-sdk/app";',
    'import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";',
    'import { rpc } from "./rpc.ts";',
    "",
    "function PingCard() {",
    "  const ping = rpc.ping.useQuery();",
    "  if (ping.isPending) {",
    "    return <p>loading…</p>;",
    "  }",
    "  if (ping.isError) {",
    "    return <p>ping failed: {ping.error.message}</p>;",
    "  }",
    "  return <p>pong: {String(ping.data.pong)}</p>;",
    "}",
    "",
    "function Panel(_props: PluginNavPanelProps) {",
    "  return (",
    "    <PluginQueryBoundary>",
    "      <PingCard />",
    "    </PluginQueryBoundary>",
    "  );",
    "}",
    "",
    "export default definePluginApp((app) => {",
    "  app.slots.navPanel({",
    '    id: "main",',
    `    title: "${id}",`,
    '    icon: "Folder",',
    '    path: "main",',
    "    component: Panel,",
    "  });",
    "});",
    "",
  ].join("\n");
}

function uiAppTestTs(id: string): string {
  return [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    'import { installDom } from "@bb-kit/core/testing";',
    "",
    "// The DOM must exist BEFORE the SDK's render harness is evaluated,",
    "// so the import is dynamic and comes after installDom().",
    "installDom();",
    'const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");',
    "",
    'test("the nav panel renders the ping result", async () => {',
    '  const captured = await loadPluginApp(() => import("./app.tsx"));',
    "  const panel = captured.navPanels[0];",
    '  assert.ok(panel, "app.tsx registers one nav panel");',
    "  const slot = renderSlot(",
    "    panel,",
    '    { subPath: "" },',
    `    { rpc: { "${wireName(id, "ping")}": async () => ({ pong: true }) } },`,
    "  );",
    '  await slot.findByText("pong: true");',
    "  slot.unmount();",
    "});",
    "",
  ].join("\n");
}

const ICON_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"',
  '  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
  '  <circle cx="12" cy="12" r="9" />',
  '  <path d="M8.5 12.5l2.5 2.5 4.5-5" />',
  "</svg>",
  "",
].join("\n");

function readme(name: string, id: string, dirName: string): string {
  return [
    `# ${name}`,
    "",
    `A bb plugin (plugin id: \`${id}\`), scaffolded by bb-kit.`,
    "",
    "## Develop",
    "",
    "```sh",
    "npm install",
    "npm test           # every tier, no bb instance needed",
    "npm run typecheck",
    "npx bb-kit check   # static wiring + manifest verification",
    "```",
    "",
    "Add a unit with `npx bb-kit add query|mutation|command <kebab-name>`;",
    "it prints the exact lines to wire into server.ts. Generators never",
    "edit existing files.",
    "",
    "## Install into bb (tag-and-install)",
    "",
    "bb installs plugins from git tags — there is no npm publish step.",
    "Commit, tag, push, then point bb at the tag:",
    "",
    "```sh",
    "git tag v0.1.0",
    "git push origin v0.1.0",
    `bb plugin install git:<your-git-remote>@semver:^0.1   # e.g. git:github.com/you/${dirName}@semver:^0.1`,
    "```",
    "",
    "Cut a new tag for each release and re-install to update.",
    "",
  ].join("\n");
}

/** Every scaffold file for `packageName`, keyed by path inside the new dir. */
export function scaffoldFiles(packageName: string): {
  id: string;
  files: Record<string, string>;
} {
  const id = derivePluginID(packageName);
  const dirName = packageName.startsWith("@")
    ? packageName.slice(packageName.indexOf("/") + 1)
    : packageName;
  const files: Record<string, string> = {
    "package.json": packageJson(packageName, id),
    "tsconfig.json": TSCONFIG,
    "server.ts": serverTs(id),
    "server.test.ts": serverTestTs(id),
    "server/context.ts": SERVER_CONTEXT_TS,
    "rpc/ping.ts": RPC_PING_TS,
    "rpc/ping.test.ts": RPC_PING_TEST_TS,
    "cli/status.ts": CLI_STATUS_TS,
    "cli/status.test.ts": CLI_STATUS_TEST_TS,
    "ui/rpc.ts": uiRPCTs(id),
    "ui/app.tsx": uiAppTsx(id),
    "ui/app.test.ts": uiAppTestTs(id),
    "assets/icon.svg": ICON_SVG,
    "README.md": readme(packageName, id, dirName),
  };
  return { id, files };
}
