// The UI spec language: compile once (server and client), then evaluate on
// every state change. Pure TypeScript, no eval, no host globals.
import type { Program } from "./ast";
import { LIMITS } from "./catalog";
import { DiagnosticList } from "./diagnostics";
import { tokenize } from "./lexer";
import { parse } from "./parser";
import type { Diagnostic } from "./types";
import { validate } from "./validate";

export type { Program } from "./ast";
export { collectLoads, dataKey, MAX_SNIPPET_LINES, parseDataFile, type DataRequest, type LoadedData } from "./data";
export { evaluate, initialState } from "./evaluate";
export { formMessage } from "./form";
export {
  imageSearches,
  specToMarkdown,
  toMarkdown,
  toMarkdownWithImages,
  wikiPhotos,
  type SearchedImage,
} from "./markdown";
export { MAX_PROBES, probeInteractions, type ProbeReport } from "./probe";
export { compileStreaming } from "./streaming";

/** Parses and validates a spec. `program` is null iff there is at least one error. */
export function compile(source: string): { program: Program | null; diagnostics: Diagnostic[] } {
  const diagnostics = new DiagnosticList();
  if (source.length > LIMITS.sourceChars) {
    diagnostics.report(
      { line: 1, column: 1 },
      `the spec has ${source.length} characters; the limit is ${LIMITS.sourceChars}`,
    );
    return { program: null, diagnostics: diagnostics.items };
  }
  const statements = parse(tokenize(source, diagnostics), diagnostics);
  // Validating after syntax errors would mostly report their fallout.
  const program = diagnostics.hasErrors ? null : validate(statements, diagnostics);
  const sorted = [...diagnostics.items].sort((a, b) => a.line - b.line || a.column - b.column);
  return { program: diagnostics.hasErrors ? null : program, diagnostics: sorted };
}

/** One diagnostic per line: `3:5 error: message`. */
export function formatDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics.map((d) => `${d.line}:${d.column} ${d.severity}: ${d.message}`).join("\n");
}
