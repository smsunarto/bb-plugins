import type { DiagnosticList, Pos } from "./diagnostics";

export type Token =
  | (Pos & { readonly t: "num"; readonly value: number })
  | (Pos & { readonly t: "str"; readonly value: string })
  /** `quasis` has one more entry than `parts`; each part ends with an `eof` token at its `}`. */
  | (Pos & {
      readonly t: "tpl";
      readonly quasis: readonly string[];
      readonly parts: readonly (readonly Token[])[];
    })
  /** `state` holds the name without `$`. */
  | (Pos & { readonly t: "ident" | "state" | "punct"; readonly value: string })
  /** A statement separator: a newline at bracket depth 0, or `;`. */
  | (Pos & { readonly t: "sep"; readonly value: "\n" | ";" })
  | (Pos & { readonly t: "eof" });

const PUNCTUATION = [
  "===", "!==",
  "==", "!=", "<=", ">=", "&&", "||", "??", "=>", "**",
  "(", ")", "[", "]", "{", "}", ",", ":", ".", "?", "<", ">", "+", "-", "*", "/", "%", "!", "=",
];

/** A newline right after one of these continues the statement on the next line. */
const CONTINUES_AFTER: Record<string, true> = {
  "+": true, "-": true, "*": true, "/": true, "%": true, "**": true,
  "==": true, "!=": true, "===": true, "!==": true,
  "<": true, "<=": true, ">": true, ">=": true,
  "&&": true, "||": true, "??": true, "?": true, ":": true,
  ".": true, "=": true, "=>": true,
};

/** A line starting with one of these continues the previous line (none can start an expression). */
const CONTINUES_BEFORE: Record<string, true> = {
  "+": true, "*": true, "/": true, "%": true, "**": true,
  "==": true, "!=": true, "===": true, "!==": true,
  "<": true, "<=": true, ">": true, ">=": true,
  "&&": true, "||": true, "??": true, "?": true, ":": true,
  ".": true, "=>": true,
};

const NUMBER = /\d(?:_?\d)*(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d+)?/y;
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const IDENT_CHAR = /[A-Za-z0-9_]/;
const HEX = /^[0-9a-fA-F]+$/;

const ESCAPES: Record<string, string> = {
  n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "`": "`", $: "$",
};

export function tokenize(source: string, diagnostics: DiagnosticList): Token[] {
  return new Lexer(source, diagnostics).run(false);
}

class Lexer {
  private i = 0;
  private line = 1;
  private column = 1;

  constructor(
    private readonly src: string,
    private readonly diagnostics: DiagnosticList,
  ) {}

  private advance(count = 1): void {
    for (let n = 0; n < count; n++) {
      if (this.src[this.i] === "\n") {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.i++;
    }
  }

  private match(re: RegExp): string | null {
    re.lastIndex = this.i;
    const m = re.exec(this.src);
    return m ? m[0] : null;
  }

  /**
   * Top level: tokens until end of input, separators at bracket depth 0.
   * Inside a template `${`: tokens until the matching `}`, no separators.
   */
  run(inTemplate: boolean): Token[] {
    const out: Token[] = [];
    let depth = 0;
    for (;;) {
      this.skipBlank();
      const pos = { line: this.line, column: this.column };
      const c = this.src[this.i];
      if (c === undefined) {
        if (inTemplate) this.diagnostics.report(pos, "unterminated template: `${` is missing its `}`");
        out.push({ ...pos, t: "eof" });
        return inTemplate ? out : joinContinuations(out);
      }
      if (c === "\n") {
        this.advance();
        if (!inTemplate && depth === 0) out.push({ ...pos, t: "sep", value: "\n" });
        continue;
      }
      if (c === ";") {
        this.advance();
        out.push({ ...pos, t: "sep", value: ";" });
        continue;
      }
      if (inTemplate && c === "}" && depth === 0) {
        out.push({ ...pos, t: "eof" });
        this.advance();
        return out;
      }
      const number = this.match(NUMBER);
      if (number !== null) {
        this.advance(number.length);
        if (IDENT_CHAR.test(this.src[this.i] ?? "")) {
          this.diagnostics.report(pos, `invalid number \`${number}${this.src[this.i]}\``);
        }
        out.push({ ...pos, t: "num", value: Number(number.replaceAll("_", "")) });
        continue;
      }
      const ident = this.match(IDENT);
      if (ident !== null) {
        this.advance(ident.length);
        out.push({ ...pos, t: "ident", value: ident });
        continue;
      }
      if (c === "$") {
        this.advance();
        const name = this.match(IDENT);
        if (name === null) {
          this.diagnostics.report(pos, "expected a state name after `$`, as in `$count`");
          continue;
        }
        this.advance(name.length);
        out.push({ ...pos, t: "state", value: name });
        continue;
      }
      if (c === '"' || c === "'") {
        const value = this.string(c, pos);
        if (value !== null) out.push({ ...pos, t: "str", value });
        continue;
      }
      if (c === "`") {
        out.push(this.template(pos));
        continue;
      }
      const punct = PUNCTUATION.find((p) => this.src.startsWith(p, this.i));
      if (punct === undefined) {
        this.diagnostics.report(pos, `unexpected character \`${c}\``);
        this.advance();
        continue;
      }
      if (punct === "(" || punct === "[" || punct === "{") depth++;
      if ((punct === ")" || punct === "]" || punct === "}") && depth > 0) depth--;
      this.advance(punct.length);
      out.push({ ...pos, t: "punct", value: punct });
    }
  }

  private skipBlank(): void {
    for (;;) {
      const c = this.src[this.i];
      if (c === " " || c === "\t" || c === "\r") {
        this.advance();
      } else if (c === "/" && this.src[this.i + 1] === "/") {
        while (this.i < this.src.length && this.src[this.i] !== "\n") this.advance();
      } else {
        return;
      }
    }
  }

  /** Reads one escape after `\`; returns the decoded text or null after reporting. */
  private escape(): string | null {
    const pos = { line: this.line, column: this.column };
    this.advance();
    const c = this.src[this.i];
    if (c !== undefined && ESCAPES[c] !== undefined) {
      this.advance();
      return ESCAPES[c];
    }
    if (c === "u") {
      const braced = this.src[this.i + 1] === "{";
      const end = braced ? this.src.indexOf("}", this.i + 2) : this.i + 5;
      const hex = braced ? this.src.slice(this.i + 2, end) : this.src.slice(this.i + 1, end);
      const code = parseInt(hex, 16);
      if (end > 0 && HEX.test(hex) && (braced || hex.length === 4) && code <= 0x10ffff) {
        this.advance(end - this.i + (braced ? 1 : 0));
        return String.fromCodePoint(code);
      }
    }
    this.diagnostics.report(pos, `unknown escape \`\\${c ?? ""}\`; use \\n \\t \\\\ \\" \\' \\$ or \\u{hex}`);
    return null;
  }

  private string(quote: string, pos: Pos): string | null {
    this.advance();
    let value = "";
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined || c === "\n") {
        this.diagnostics.report(pos, `unterminated string: close it with ${quote} on the same line`);
        return null;
      }
      if (c === quote) {
        this.advance();
        return value;
      }
      if (c === "\\") {
        value += this.escape() ?? "";
        continue;
      }
      value += c;
      this.advance();
    }
  }

  private template(pos: Pos): Token {
    this.advance();
    const quasis: string[] = [];
    const parts: Token[][] = [];
    let text = "";
    for (;;) {
      const c = this.src[this.i];
      if (c === undefined) {
        this.diagnostics.report(pos, "unterminated template: close it with `");
        quasis.push(text);
        return { ...pos, t: "tpl", quasis, parts };
      }
      if (c === "`") {
        this.advance();
        quasis.push(text);
        return { ...pos, t: "tpl", quasis, parts };
      }
      if (c === "\\") {
        text += this.escape() ?? "";
      } else if (c === "$" && this.src[this.i + 1] === "{") {
        this.advance(2);
        quasis.push(text);
        text = "";
        parts.push(this.run(true));
      } else {
        text += c;
        this.advance();
      }
    }
  }
}

/**
 * Drops redundant separators, and newlines that sit between an operator and
 * its operand, so `a +⏎ b` and `cond⏎ ? x⏎ : y` stay one statement.
 */
function joinContinuations(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const last = out[out.length - 1];
    if (token.t === "sep") {
      if (last === undefined || last.t === "sep") continue;
      if (token.value === "\n" && last.t === "punct" && CONTINUES_AFTER[last.value]) continue;
    } else if (
      token.t === "punct" &&
      CONTINUES_BEFORE[token.value] &&
      last?.t === "sep" &&
      last.value === "\n"
    ) {
      out.pop();
    }
    out.push(token);
  }
  return out;
}
