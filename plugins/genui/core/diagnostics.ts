import type { Diagnostic } from "./types";

/** A 1-based source position. Tokens and AST nodes carry one. */
export interface Pos {
  readonly line: number;
  readonly column: number;
}

const MAX_DIAGNOSTICS = 20;

/** Collects up to 20 diagnostics, dropping exact duplicates. */
export class DiagnosticList {
  readonly items: Diagnostic[] = [];
  hasErrors = false;
  private readonly seen = new Set<string>();

  report(pos: Pos, message: string, severity: Diagnostic["severity"] = "error"): void {
    if (severity === "error") this.hasErrors = true;
    const id = `${pos.line}:${pos.column}:${message}`;
    if (this.items.length >= MAX_DIAGNOSTICS || this.seen.has(id)) return;
    this.seen.add(id);
    this.items.push({ severity, line: pos.line, column: pos.column, message });
  }
}
