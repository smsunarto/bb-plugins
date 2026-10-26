import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const missing: string[] = [];
for (const id of readdirSync("plugins")) {
  const manifest = join("plugins", id, "package.json");
  if (!existsSync(manifest)) continue;
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  if (!pkg.devDependencies?.["@bb-plugins/ui"]) continue;
  const appPath = join("plugins", id, "dist/app.js");
  if (!existsSync(appPath)) {
    missing.push(`${id}: build the app before checking CSS`);
    continue;
  }
  const candidates = new Set(
    readFileSync(appPath, "utf8").match(/\bbbui-[a-f0-9]{12}-[a-z][a-z-]*/g) ?? [],
  );
  // A plugin using only cn has no control styles in its tree-shaken bundle.
  if (!candidates.size) {
    // cn-only (inline-vis) and a tree-shaken unused Button (gtd-sidebar) have no styles.
    if (!["html", "gtd-sidebar"].includes(id))
      missing.push(`${id}: shared controls missing from app bundle`);
    continue;
  }
  const path = join("plugins", id, "dist/app.css");
  const css = existsSync(path) ? readFileSync(path, "utf8") : "";
  for (const token of candidates) {
    if (!css.includes(`.${token}`)) missing.push(`${id}: missing ${token} in built CSS`);
  }
}
if (missing.length) throw new Error(missing.join("\n"));
console.log("Shared UI CSS is present in every consumer bundle.");
