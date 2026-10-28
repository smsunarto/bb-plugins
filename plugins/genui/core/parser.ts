import type { BinaryOperator, Expr, NamedArg, Statement } from "./ast";
import type { DiagnosticList, Pos } from "./diagnostics";
import type { Token } from "./lexer";

const PRECEDENCE: Record<string, number> = {
  "??": 1,
  "||": 2,
  "&&": 3,
  "==": 4, "!=": 4, "===": 4, "!==": 4,
  "<": 5, "<=": 5, ">": 5, ">=": 5,
  "+": 6, "-": 6,
  "*": 7, "/": 7, "%": 7,
};

const KEYWORDS: Record<string, true | false | null> = { true: true, false: false, null: null };

/** AST depth beyond this is rejected so later tree walks cannot overflow the stack. */
const MAX_NESTING = 100;

class ParseError {
  constructor(
    readonly pos: Pos,
    readonly message: string,
  ) {}
}

function describe(token: Token): string {
  switch (token.t) {
    case "num":
      return `number ${token.value}`;
    case "str":
      return "a string";
    case "tpl":
      return "a template string";
    case "ident":
      return `\`${token.value}\``;
    case "state":
      return `\`$${token.value}\``;
    case "punct":
      return `\`${token.value}\``;
    case "sep":
      return token.value === ";" ? "`;`" : "end of line";
    case "eof":
      return "end of input";
  }
}

/** Parses all statements; syntax errors are reported and their statement skipped. */
export function parse(tokens: readonly Token[], diagnostics: DiagnosticList): Statement[] {
  const parser = new Parser(tokens, 0);
  const statements: Statement[] = [];
  for (;;) {
    while (parser.peek().t === "sep") parser.i++;
    if (parser.peek().t === "eof") return statements;
    try {
      statements.push(parser.statement());
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      diagnostics.report(error.pos, error.message);
      while (parser.peek().t !== "sep" && parser.peek().t !== "eof") parser.i++;
    }
  }
}

class Parser {
  i = 0;

  constructor(
    private readonly tokens: readonly Token[],
    private depth: number,
  ) {}

  peek(offset = 0): Token {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  private isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.t === "punct" && token.value === value;
  }

  private eat(value: string): boolean {
    if (!this.isPunct(value)) return false;
    this.i++;
    return true;
  }

  /** Consumes the closer of `open`, or fails naming what else was acceptable. */
  private close(closer: string, open: Token, alternatives = ""): void {
    if (this.eat(closer)) return;
    const opener = open.t === "punct" ? open.value : "(";
    throw new ParseError(
      this.peek(),
      `expected ${alternatives}\`${closer}\` to close \`${opener}\` from ${open.line}:${open.column}, found ${describe(this.peek())}`,
    );
  }

  private ident(what: string): Pos & { readonly value: string } {
    const token = this.peek();
    if (token.t !== "ident") throw new ParseError(token, `expected ${what}, found ${describe(token)}`);
    this.i++;
    return token;
  }

  statement(): Statement {
    this.depth = 0;
    const first = this.peek();
    let statement: Statement;
    if ((first.t === "state" || first.t === "ident") && this.isPunct("=", 1)) {
      if (first.t === "ident" && Object.hasOwn(KEYWORDS, first.value)) {
        throw new ParseError(first, `\`${first.value}\` is a keyword and cannot be assigned`);
      }
      this.i += 2;
      const kind = first.t === "state" ? "state" : "named";
      statement = { kind, name: first.value, value: this.expr(), pos: first };
    } else {
      statement = { kind: "root", value: this.expr() };
    }
    const next = this.peek();
    if (next.t !== "sep" && next.t !== "eof") {
      throw new ParseError(
        next,
        `expected a new line or \`;\` after the statement, found ${describe(next)}; wrap multi-line expressions in brackets`,
      );
    }
    return statement;
  }

  /** Counts one level of AST nesting; callers restore `depth` when their subtree is done. */
  private nest(at: Token): void {
    if (++this.depth > MAX_NESTING) throw new ParseError(at, "expression is nested too deeply; split it into named values");
  }

  private expr(): Expr {
    const saved = this.depth;
    this.nest(this.peek());
    const expr = this.isArrowStart() ? this.arrow() : this.conditional();
    this.depth = saved;
    return expr;
  }

  private isArrowStart(): boolean {
    if (this.peek().t === "ident") return this.isPunct("=>", 1);
    if (!this.isPunct("(")) return false;
    let offset = 1;
    if (this.peek(offset).t === "ident") {
      offset++;
      while (this.isPunct(",", offset) && this.peek(offset + 1).t === "ident") offset += 2;
    }
    return this.isPunct(")", offset) && this.isPunct("=>", offset + 1);
  }

  private arrow(): Expr {
    const start = this.peek();
    const params: string[] = [];
    if (this.eat("(")) {
      while (!this.eat(")")) {
        params.push(this.ident("a parameter name").value);
        this.eat(",");
      }
    } else {
      params.push(this.ident("a parameter name").value);
    }
    const keyword = params.find((name) => Object.hasOwn(KEYWORDS, name));
    if (keyword !== undefined) throw new ParseError(start, `\`${keyword}\` cannot be a parameter name`);
    this.i++; // `=>`, guaranteed by isArrowStart
    return { type: "arrow", params, body: this.expr(), pos: start };
  }

  private conditional(): Expr {
    const test = this.binary(1);
    const question = this.peek();
    if (!this.eat("?")) return test;
    const then = this.expr();
    if (!this.eat(":")) {
      throw new ParseError(this.peek(), `expected \`:\` for the \`?\` at ${question.line}:${question.column}, found ${describe(this.peek())}`);
    }
    return { type: "conditional", test, then, else: this.expr(), pos: question };
  }

  private binary(minPrecedence: number): Expr {
    const saved = this.depth;
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token.t !== "punct") break;
      const precedence = PRECEDENCE[token.value];
      if (precedence === undefined || precedence < minPrecedence) break;
      this.nest(token);
      this.i++;
      const right = this.binary(precedence + 1);
      left = { type: "binary", op: token.value as BinaryOperator, left, right, pos: token };
    }
    this.depth = saved;
    return left;
  }

  private unary(): Expr {
    const saved = this.depth;
    const operators: Token[] = [];
    while (this.isPunct("!") || this.isPunct("-")) {
      this.nest(this.peek());
      operators.push(this.tokens[this.i++]);
    }
    let expr = this.postfix();
    // `**` binds tighter than a prefix operator and associates to the right,
    // as in maths and Python: `-a ** b` is `-(a ** b)`, `a ** b ** c` is `a ** (b ** c)`.
    if (this.isPunct("**")) {
      const token = this.peek();
      this.nest(token);
      this.i++;
      expr = { type: "binary", op: "**", left: expr, right: this.unary(), pos: token };
    }
    for (let k = operators.length - 1; k >= 0; k--) {
      const token = operators[k];
      expr = { type: "unary", op: token.t === "punct" && token.value === "!" ? "!" : "-", operand: expr, pos: token };
    }
    this.depth = saved;
    return expr;
  }

  private postfix(): Expr {
    let expr = this.primary();
    for (;;) {
      if (this.isPunct(".") || this.isPunct("[") || this.isPunct("(")) this.nest(this.peek());
      if (this.eat(".")) {
        const name = this.ident("a property or method name after `.`");
        if (this.isPunct("(")) {
          // `Math.round(x)` and `Object.entries(o)` are how models write the
          // built-ins; they parse as the plain calls `round(x)` and `entries(o)`.
          expr =
            expr.type === "ident" && (expr.name === "Math" || expr.name === "Object")
              ? { type: "call", name: name.value, ...this.args(), pos: name }
              : { type: "method", object: expr, name: name.value, ...this.args(), pos: name };
        } else {
          expr = { type: "member", object: expr, name: name.value, pos: name };
        }
      } else if (this.isPunct("[")) {
        const open = this.tokens[this.i++];
        const index = this.expr();
        this.close("]", open);
        expr = { type: "index", object: expr, index, pos: open };
      } else if (this.isPunct("(")) {
        if (expr.type !== "ident") {
          throw new ParseError(this.peek(), "only components, actions, functions and methods can be called");
        }
        expr = { type: "call", name: expr.name, ...this.args(), pos: expr.pos };
      } else {
        return expr;
      }
    }
  }

  private args(): { args: Expr[]; named: NamedArg[] } {
    const open = this.tokens[this.i++];
    const args: Expr[] = [];
    const named: NamedArg[] = [];
    while (!this.eat(")")) {
      const token = this.peek();
      if (token.t === "ident" && this.isPunct(":", 1)) {
        this.i += 2;
        named.push({ name: token.value, value: this.expr(), pos: token });
      } else {
        if (named.length > 0) {
          throw new ParseError(token, "positional arguments must come before named ones");
        }
        args.push(this.expr());
      }
      if (!this.eat(",")) {
        this.close(")", open, "`,` or ");
        break;
      }
    }
    return { args, named };
  }

  private primary(): Expr {
    const token = this.peek();
    switch (token.t) {
      case "num":
      case "str":
        this.i++;
        return { type: "literal", value: token.value, pos: token };
      case "tpl": {
        this.i++;
        const parts = token.parts.map((tokens) => {
          const sub = new Parser(tokens, this.depth);
          const part = sub.expr();
          const end = sub.peek();
          if (end.t !== "eof") {
            throw new ParseError(end, `expected \`}\` to end the template expression, found ${describe(end)}`);
          }
          return part;
        });
        return { type: "template", quasis: token.quasis, parts, pos: token };
      }
      case "ident":
        this.i++;
        if (Object.hasOwn(KEYWORDS, token.value)) return { type: "literal", value: KEYWORDS[token.value], pos: token };
        return { type: "ident", name: token.value, pos: token };
      case "state":
        this.i++;
        return { type: "state", name: token.value, pos: token };
      case "punct":
        if (token.value === "(") {
          this.i++;
          const inner = this.expr();
          this.close(")", token);
          return inner;
        }
        if (token.value === "[") {
          this.i++;
          const items: Expr[] = [];
          while (!this.eat("]")) {
            items.push(this.expr());
            if (!this.eat(",")) {
              this.close("]", token, "`,` or ");
              break;
            }
          }
          return { type: "list", items, pos: token };
        }
        if (token.value === "{") return this.object(token);
        break;
    }
    throw new ParseError(token, `expected an expression, found ${describe(token)}`);
  }

  private object(open: Token): Expr {
    this.i++;
    const entries: { key: string; value: Expr; pos: Pos }[] = [];
    while (!this.eat("}")) {
      const key = this.peek();
      if (key.t !== "ident" && key.t !== "str") {
        throw new ParseError(key, `expected an object key (a name or a string), found ${describe(key)}`);
      }
      this.i++;
      // `{Good for: …}`: models write labels as bare words; nothing else may follow a key, so read them as one.
      let name = key.value;
      if (key.t === "ident") {
        for (let next = this.peek(); next.t === "ident" || next.t === "num"; next = this.peek()) {
          name += ` ${next.value}`;
          this.i++;
        }
      }
      if (!this.eat(":")) throw new ParseError(this.peek(), `expected \`:\` after the object key, found ${describe(this.peek())}`);
      entries.push({ key: name, value: this.expr(), pos: key });
      if (!this.eat(",")) {
        this.close("}", open, "`,` or ");
        break;
      }
    }
    return { type: "object", entries, pos: open };
  }
}
