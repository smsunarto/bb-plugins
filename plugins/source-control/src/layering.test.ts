/**
 * The layers depend one way: core ← contract ← {host, server, app}, with
 * `forge` beside contract for server and host only. A file importing against
 * that direction fails here, before it couples two tiers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { expect, test } from "vitest";

const SRC = resolve(import.meta.dirname);

/** Which layers each layer may import from inside `src`. */
const ALLOWED: Record<string, readonly string[]> = {
  core: ["core"],
  contract: ["core", "contract"],
  forge: ["core", "forge"],
  host: ["core", "contract", "forge", "host"],
  server: ["core", "contract", "forge", "server"],
  app: ["core", "contract", "app"],
};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every module an import or re-export statement names. */
function specifiers(source: string): string[] {
  return [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gms)].map(
    (match) => match[1]!,
  );
}

function layerOf(path: string): string | null {
  const first = relative(SRC, path).split(/[\\/]/)[0]!;
  return first in ALLOWED ? first : null;
}

test("imports between layers only point toward core", () => {
  const violations: string[] = [];
  for (const file of files(SRC)) {
    const layer = layerOf(file);
    if (!layer) continue;
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiers(source).filter((name) => name.startsWith("."))) {
      const target = layerOf(resolve(dirname(file), specifier));
      if (target && !ALLOWED[layer]!.includes(target))
        violations.push(`${relative(SRC, file)} imports ${target} (${specifier})`);
    }
  }
  expect(violations).toEqual([]);
});

test("core and contract stay free of the SDK's runtime-specific entry points", () => {
  const violations: string[] = [];
  for (const file of files(join(SRC, "core")).concat(files(join(SRC, "contract")))) {
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiers(source).filter((name) => !name.startsWith("."))) {
      const core = relative(SRC, file).startsWith("core");
      const allowed = core ? ["zod"] : ["zod", "@get-bb/plugin-sdk"];
      if (!allowed.includes(specifier))
        violations.push(`${relative(SRC, file)} imports ${specifier}`);
    }
  }
  expect(violations).toEqual([]);
});

test("Effect runs on the server only: host, app, forge, core and contract stay Effect-free", () => {
  const violations: string[] = [];
  for (const file of files(SRC)) {
    const layer = layerOf(file);
    if (!layer || layer === "server") continue;
    for (const specifier of specifiers(readFileSync(file, "utf8")))
      if (
        specifier === "effect" ||
        specifier.startsWith("effect/") ||
        specifier.startsWith("@bb-plugins/effect-bridge")
      )
        violations.push(`${relative(SRC, file)} imports ${specifier}`);
  }
  expect(violations).toEqual([]);
});
