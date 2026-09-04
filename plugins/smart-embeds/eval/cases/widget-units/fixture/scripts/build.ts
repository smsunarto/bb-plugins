const SOURCE_DIR = new URL("../src/", import.meta.url);
const OUTPUT = new URL("../generated/widget.js", import.meta.url);
const MANIFEST = new URL("../package.json", import.meta.url);
const GLOBAL_NAME = "WeatherWidget";

const typescript = new Bun.Transpiler({ loader: "ts" });
const minifier = new Bun.Transpiler({ loader: "js", minifyWhitespace: true });

async function sourceNames(): Promise<string[]> {
  const names: string[] = [];
  for await (const name of new Bun.Glob("*.ts").scan({ cwd: Bun.fileURLToPath(SOURCE_DIR) })) {
    names.push(name);
  }
  // Name order, so the same sources always land in the same place in the bundle
  // and the hash only moves when the code moves.
  return names.sort();
}

/**
 * The bundle is a single scope, so the cross file wiring is noise inside it.
 *
 * Only top level statements sit at column zero in transpiler output, which is
 * what keeps this from reaching into a string that happens to span lines.
 */
function stripModuleSyntax(code: string): string {
  return code
    .split("\n")
    .filter((line) => !(line.startsWith("import ") && line.endsWith(";")))
    .map((line) => (line.startsWith("export ") ? line.slice("export ".length) : line))
    .join("\n");
}

function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

const manifest = (await Bun.file(MANIFEST).json()) as { name: string; version: string };
const names = await sourceNames();
const exported = new Set<string>();
const chunks: string[] = [];

for (const name of names) {
  const source = await Bun.file(new URL(name, SOURCE_DIR)).text();
  for (const exportName of typescript.scan(source).exports) exported.add(exportName);
  chunks.push(stripModuleSyntax(typescript.transformSync(source)));
}

const publicNames = [...exported].sort();
const joined = `${chunks.join("\n")}\nglobalThis.${GLOBAL_NAME}={${publicNames.join(",")}};`;
const body = minifier.transformSync(joined).trim();
const banner = `/* ${manifest.name} ${manifest.version} ${contentHash(body)} */`;

await Bun.write(OUTPUT, `${banner}\n(()=>{${body}})();\n`);
console.log(`generated/widget.js: ${names.length} sources, ${publicNames.length} exports`);
