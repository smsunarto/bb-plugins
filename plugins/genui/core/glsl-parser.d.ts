// Types for glsl-parser.js: what @shaderfrog/glsl-parser 7 returns, as far
// as core/glsl-check.ts reads it.

export interface GlslLocation {
  readonly start: { readonly line: number; readonly column: number };
}

/** An AST node that refers to a name; it has a location with `includeLocation`. */
export interface GlslReference {
  readonly type: string;
  readonly location?: GlslLocation;
}

/** One name in a scope; `declaration` is absent when the parser never saw it declared. */
export interface GlslScopeEntry {
  readonly declaration?: unknown;
  readonly references: readonly GlslReference[];
}

export interface GlslScope {
  readonly name: string;
  readonly bindings: Readonly<Record<string, GlslScopeEntry>>;
  readonly types: Readonly<Record<string, GlslScopeEntry>>;
  /** Overloads of each function by signature. */
  readonly functions: Readonly<Record<string, Readonly<Record<string, GlslScopeEntry>>>>;
}

export interface GlslProgram {
  readonly type: "program";
  readonly scopes: readonly GlslScope[];
}

export interface GlslParserOptions {
  readonly stage?: "vertex" | "fragment" | "either";
  readonly quiet?: boolean;
  readonly includeLocation?: boolean;
  readonly failOnWarn?: boolean;
}

/** Throws a GlslParseError on a syntax error. */
export function parse(source: string, options?: GlslParserOptions): GlslProgram;

/**
 * What `parse` throws for a syntax error: a plain Error with peggy's fields
 * (the package's GlslSyntaxError class is not what it throws).
 */
export interface GlslParseError extends Error {
  readonly location: GlslLocation;
  /** The text found where the parse failed; null at the end of the input. */
  readonly found: string | null;
}

/** Expands macros and evaluates #if; directive lines are dropped from the output. */
export function preprocess(source: string, options?: { readonly preserveComments?: boolean }): string;
