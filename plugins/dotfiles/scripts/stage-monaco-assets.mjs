import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const distDir = path.join(pluginRoot, "dist");
const outDir = path.join(distDir, "monaco");
const assetNames = ["editor.js", "editor.css", "editor.worker.js"];
const require = createRequire(path.join(pluginRoot, "package.json"));
const esbuild = require("esbuild");

async function mtime(file) {
  try {
    const entry = await stat(file);
    return entry.isFile() ? entry.mtimeMs : null;
  } catch {
    return null;
  }
}

async function bundleIsFresh() {
  const outputTimes = await Promise.all(assetNames.map((name) => mtime(path.join(outDir, name))));
  if (outputTimes.some((value) => value === null)) return false;
  const bundleDir = path.join(pluginRoot, "monaco-bundle");
  const bundleInputs = (await readdir(bundleDir)).map((name) => path.join(bundleDir, name));
  const inputs = [
    import.meta.filename,
    path.join(pluginRoot, "package.json"),
    ...bundleInputs,
  ];
  const inputTimes = await Promise.all(inputs.map(mtime));
  const newestInput = Math.max(...inputTimes.filter((value) => value !== null));
  const oldestOutput = Math.min(...outputTimes);
  return newestInput <= oldestOutput;
}

async function validateBundle(stageDir, editorBuild) {
  const inputs = Object.keys(editorBuild.metafile.inputs);
  const output = await readFile(path.join(stageDir, "editor.js"), "utf8");
  const missing = [
    ["language grammars", () => inputs.some((input) => input.includes("languages/definitions/") || input.includes("basic-languages"))],
    ["editor contributions", () => inputs.some((input) => input.includes("editor/contrib/"))],
    ["find widget", () => output.includes("find-widget")],
    ["folding", () => output.includes("foldRecursively")],
    ["word navigation", () => output.includes("cursorWordLeft")],
    ["line sorting", () => output.includes("sortLinesAscending")],
  ]
    .filter(([, present]) => !present())
    .map(([name]) => name);
  for (const name of assetNames) {
    const entry = await stat(path.join(stageDir, name));
    if (!entry.isFile() || entry.size === 0) missing.push(name);
  }
  if (missing.length > 0) {
    throw new Error(`the Monaco bundle is missing: ${missing.join(", ")}`);
  }
}

async function promote(stageDir) {
  const backupDir = path.join(distDir, `.monaco-previous-${process.pid}-${Date.now()}`);
  let backedUp = false;
  try {
    await rename(outDir, backupDir);
    backedUp = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(stageDir, outDir);
  } catch (error) {
    if (backedUp) await rename(backupDir, outDir);
    throw error;
  }
  if (backedUp) await rm(backupDir, { recursive: true, force: true });
}

if (await bundleIsFresh()) {
  console.log(`monaco: current ${outDir}`);
  process.exit(0);
}

await mkdir(distDir, { recursive: true });
const stageDir = await mkdtemp(path.join(distDir, ".monaco-stage-"));
try {
  const shared = {
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    absWorkingDir: pluginRoot,
    loader: { ".ttf": "dataurl" },
  };
  const editorBuild = await esbuild.build({
    ...shared,
    entryPoints: [path.join(pluginRoot, "monaco-bundle", "editor.js")],
    outfile: path.join(stageDir, "editor.js"),
    metafile: true,
  });
  const workerBuild = await esbuild.build({
    ...shared,
    entryPoints: [path.join(pluginRoot, "monaco-bundle", "worker.js")],
    outfile: path.join(stageDir, "editor.worker.js"),
    metafile: true,
  });
  await validateBundle(stageDir, editorBuild);
  await promote(stageDir);
  const total = [...Object.values(editorBuild.metafile.outputs), ...Object.values(workerBuild.metafile.outputs)]
    .reduce((bytes, output) => bytes + output.bytes, 0);
  console.log(`monaco: built ${outDir} (${(total / 1024 / 1024).toFixed(2)} MB)`);
} finally {
  await rm(stageDir, { recursive: true, force: true });
}
