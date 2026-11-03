/** Freeze existing lint debt without permitting new occurrences. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

interface Diagnostic {
  filename: string;
  code: string;
  message: string;
  severity: string;
  labels: { span: { line: number; column: number } }[];
}
interface Entry {
  filename: string;
  code: string;
  message: string;
  source: string;
}

export function fingerprint(
  diagnostic: Pick<Diagnostic, "filename" | "code" | "message">,
  sourceLine: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([diagnostic.filename, diagnostic.code, diagnostic.message, sourceLine.trim()]),
    )
    .digest("hex");
}
export function newErrors(actual: readonly string[], baseline: readonly string[]): string[] {
  const remaining = new Map<string, number>();
  for (const id of baseline) remaining.set(id, (remaining.get(id) ?? 0) + 1);
  return actual.filter((id) => {
    const count = remaining.get(id) ?? 0;
    if (count === 0) return true;
    remaining.set(id, count - 1);
    return false;
  });
}
if (import.meta.main) {
  const paths = process.argv.slice(2).filter((arg) => arg !== "--" && arg !== "--update");
  const result = Bun.spawnSync(["bunx", "--no-install", "oxlint", "--format", "json", ...paths], {
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new Error(`oxlint failed: ${result.exitCode}`);
  // The pinned linter owns this JSON contract; malformed output fails closed.
  const report: { diagnostics: Diagnostic[] } = JSON.parse(result.stdout.toString());
  const entries: Entry[] = [];
  for (const diagnostic of report.diagnostics) {
    const span = diagnostic.labels[0]?.span;
    if (diagnostic.severity === "error") {
      if (!span) throw new Error("An error diagnostic has no source location");
      const source = readFileSync(diagnostic.filename, "utf8").split("\n")[span.line - 1];
      if (source === undefined) throw new Error(`Invalid source location: ${diagnostic.filename}`);
      entries.push({
        filename: diagnostic.filename,
        code: diagnostic.code,
        message: diagnostic.message,
        source: source.trim(),
      });
    }
    console.log(
      `${diagnostic.filename}:${span?.line ?? 1}:${span?.column ?? 1}: ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
  entries.sort((a, b) =>
    JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0,
  );
  const path = new URL("./lint-baseline.json", import.meta.url);
  if (process.argv.includes("--update")) {
    if (paths.length) throw new Error("Update the complete baseline without file arguments");
    writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
    console.log(
      `Recorded ${entries.length} existing lint errors. Review baseline changes before committing.`,
    );
  } else {
    const recorded: Entry[] = JSON.parse(readFileSync(path, "utf8"));
    const baseline = paths.length
      ? recorded.filter((entry) => paths.includes(entry.filename))
      : recorded;
    const ids = entries.map((entry) => fingerprint(entry, entry.source));
    const saved = baseline.map((entry) => fingerprint(entry, entry.source));
    const added = newErrors(ids, saved);
    const resolved = newErrors(saved, ids);
    console.log(
      `${ids.length - added.length} known lint errors; ${added.length} new; ${resolved.length} resolved.`,
    );
    if (resolved.length) console.error("Prune resolved errors with bun scripts/lint.ts --update.");
    process.exit(
      added.length || resolved.length || (result.exitCode !== 0 && ids.length === 0) ? 1 : 0,
    );
  }
}
