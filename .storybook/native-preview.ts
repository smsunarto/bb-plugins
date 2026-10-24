import { existsSync, readFileSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { build, type Plugin } from "vite";
import { esmExternalRequirePlugin } from "rolldown/plugins";

const candidateRoot = resolve(
  process.env.BB_STORYBOOK_SOURCE ?? resolve(import.meta.dirname, "../../bb"),
);
export const nativeSourceRoot = existsSync(candidateRoot)
  ? realpathSync(candidateRoot)
  : candidateRoot;
export let nativeSourceError = "";
export const nativeSourceAvailable = existsSync(
  resolve(nativeSourceRoot, "apps/app/src/components/layout/AppPageHeader.tsx"),
);
const sharedRuntime = [/^react(?:\/|$)/, /^react-dom(?:\/|$)/, /^@tanstack\/react-query(?:\/|$)/];
const outputRoot = resolve(import.meta.dirname, `../.scratch/storybook-native/${process.pid}`);
let buildPromise: Promise<void> | undefined;
function cleanupBuild() {
  rmSync(outputRoot, { recursive: true, force: true });
}
function cleanupStaleBuilds() {
  const parent = resolve(outputRoot, "..");
  if (!existsSync(parent)) return;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      process.kill(Number(entry.name), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH")
        rmSync(resolve(parent, entry.name), { recursive: true, force: true });
    }
  }
}

async function buildNativeFrame(): Promise<void> {
  const appRoot = resolve(nativeSourceRoot, "apps/app");
  const appSource = resolve(appRoot, "src");
  let transportStubLoaded = false;
  const { forkablePluginPaths } = await import(
    pathToFileURL(resolve(appRoot, "vite-forkable-plugin-paths.ts")).href
  );
  const { sharedUiEnvSeam } = await import(
    pathToFileURL(resolve(appRoot, "vite-shared-ui-seam.ts")).href
  );
  await build({
    configFile: false,
    root: appRoot,
    base: "./",
    logLevel: "warn",
    plugins: [
      esmExternalRequirePlugin({ external: sharedRuntime }),
      forkablePluginPaths(appSource),
      sharedUiEnvSeam(),
      tailwindcss(),
      {
        name: "bb-native-preview-inputs",
        enforce: "pre",
        resolveId(id, importer) {
          if (
            id === "@/lib/sdk" ||
            id === "@/lib/sdk.js" ||
            id === resolve(appSource, "lib/sdk.ts")
          )
            return resolve(import.meta.dirname, "native-sdk.js");
          if (id === "virtual:bb-native-style.css") return "\0virtual:bb-native-style.css";
          if (
            !id.includes("native-original") &&
            importer?.startsWith(`${nativeSourceRoot}/`) &&
            /(^|\/)threadSecondaryPanelAtoms(?:\.js|\.ts)?$/.test(id)
          )
            return resolve(import.meta.dirname, "native-panel-state.jsx");
          const prefixes = [
            ["@bb-native/app/", appSource],
            ["@bb-native/ladle/", resolve(appRoot, ".ladle")],
          ];
          for (const [prefix, root] of prefixes) {
            if (prefix && root && id.startsWith(prefix))
              return this.resolve(resolve(root, id.slice(prefix.length)), importer, {
                skipSelf: true,
              });
          }
          if (id.startsWith("@bb-native/deps/"))
            return this.resolve(
              id.slice("@bb-native/deps/".length),
              resolve(appRoot, "package.json"),
              { skipSelf: true },
            );
          return null;
        },
        load(id) {
          // Resolve hooks can be bypassed by Vite's alias plugin. Replace the
          // resolved module too, so every native SDK importer gets the fixture.
          if (
            id.split("?")[0] === resolve(appSource, "lib/sdk.ts") ||
            id === resolve(import.meta.dirname, "native-sdk.js")
          ) {
            transportStubLoaded = true;
            return readFileSync(resolve(import.meta.dirname, "native-sdk.js"), "utf8");
          }
          if (id !== "\0virtual:bb-native-style.css") return null;
          return [
            readFileSync(resolve(appSource, "app.css"), "utf8").replaceAll('"@/', `"${appSource}/`),
            `@import "${resolve(import.meta.dirname, "../plugins/monokai/themes/bb-monokai.css")}";`,
            `@source "${appSource}";`,
            // One utility cascade in native mode: otherwise a later native `.grid`
            // can override a plugin's earlier responsive `@md:flex` rule.
            `@source "${resolve(import.meta.dirname, "../plugins")}";`,
            `@source "${resolve(import.meta.dirname, "../packages")}";`,
            `@source "${resolve(nativeSourceRoot, "packages/shared-ui/src")}";`,
            `@source "${resolve(nativeSourceRoot, "plugins/composer/src")}";`,
            `@source "${resolve(import.meta.dirname, "native-frame.jsx")}";`,
          ].join("\n");
        },
      },
    ],
    resolve: {
      conditions: ["source"],
      dedupe: ["react", "react-dom", "@tanstack/react-query"],
      alias: {
        "@get-bb/plugin-sdk/app": resolve(appRoot, ".ladle/plugin-sdk-app.ts"),
        "@": appSource,
      },
    },
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    build: {
      target: "esnext",
      outDir: outputRoot,
      emptyOutDir: true,
      minify: true,
      sourcemap: true,
      cssCodeSplit: false,
      lib: {
        entry: resolve(import.meta.dirname, "native-frame.jsx"),
        formats: ["es"],
        fileName: "editor",
        cssFileName: "editor",
      },
    },
  });
  if (!transportStubLoaded) throw new Error("Native BB transport fixture was not included.");
}

export async function nativePreviewPlugins(enabled = true): Promise<Plugin[]> {
  if (!enabled)
    return [
      {
        name: "bb-native-disabled",
        resolveId(id) {
          return id === "virtual:bb-native-frame" ? "\0virtual:bb-native-frame" : null;
        },
        load(id) {
          return id === "\0virtual:bb-native-frame"
            ? "export default function Disabled(){return null}"
            : null;
        },
      },
    ];
  cleanupStaleBuilds();
  if (!nativeSourceAvailable) nativeSourceError = `No BB app source at ${nativeSourceRoot}`;
  if (nativeSourceAvailable) {
    try {
      if (!existsSync(resolve(nativeSourceRoot, "apps/app/node_modules/react")))
        throw new Error("Install BB's workspace dependencies before using native previews.");
      buildPromise ??= buildNativeFrame();
      await buildPromise;
    } catch (cause) {
      nativeSourceError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  return [
    {
      name: "bb-native-preview-bundle",
      resolveId(id) {
        return id === "virtual:bb-native-frame" ? "\0virtual:bb-native-frame" : null;
      },
      load(id) {
        if (id !== "\0virtual:bb-native-frame") return null;
        if (!nativeSourceAvailable || nativeSourceError)
          return "export default function Unavailable(){return null}";
        return `import ${JSON.stringify(resolve(outputRoot, "editor.css"))}; export {default} from ${JSON.stringify(resolve(outputRoot, "editor.js"))};`;
      },
    },
    { name: "bb-native-cleanup", closeBundle: cleanupBuild },
  ];
}
