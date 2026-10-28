import type { Pos } from "./diagnostics";
import type { Scalar } from "./types";

export type BinaryOperator =
  | "??" | "||" | "&&"
  | "==" | "!=" | "===" | "!=="
  | "<" | "<=" | ">" | ">="
  | "+" | "-" | "*" | "/" | "%" | "**";

export interface NamedArg {
  readonly name: string;
  readonly value: Expr;
  readonly pos: Pos;
}

export type Expr =
  | { readonly type: "literal"; readonly value: Scalar; readonly pos: Pos }
  /** `quasis.length === parts.length + 1`. */
  | { readonly type: "template"; readonly quasis: readonly string[]; readonly parts: readonly Expr[]; readonly pos: Pos }
  /** `$name`; `name` excludes the `$`. */
  | { readonly type: "state"; readonly name: string; readonly pos: Pos }
  /** A named value or an arrow parameter. */
  | { readonly type: "ident"; readonly name: string; readonly pos: Pos }
  | { readonly type: "list"; readonly items: readonly Expr[]; readonly pos: Pos }
  | {
      readonly type: "object";
      readonly entries: readonly { readonly key: string; readonly value: Expr; readonly pos: Pos }[];
      readonly pos: Pos;
    }
  | { readonly type: "unary"; readonly op: "!" | "-"; readonly operand: Expr; readonly pos: Pos }
  | { readonly type: "binary"; readonly op: BinaryOperator; readonly left: Expr; readonly right: Expr; readonly pos: Pos }
  | { readonly type: "conditional"; readonly test: Expr; readonly then: Expr; readonly else: Expr; readonly pos: Pos }
  /** `object.name`; `pos` is the property name. */
  | { readonly type: "member"; readonly object: Expr; readonly name: string; readonly pos: Pos }
  | { readonly type: "index"; readonly object: Expr; readonly index: Expr; readonly pos: Pos }
  /** `name(...)`: a component, action or function; `pos` is the name (the node key). */
  | {
      readonly type: "call";
      readonly name: string;
      readonly args: readonly Expr[];
      readonly named: readonly NamedArg[];
      readonly pos: Pos;
    }
  /** `object.name(...)`; `pos` is the method name. */
  | {
      readonly type: "method";
      readonly object: Expr;
      readonly name: string;
      readonly args: readonly Expr[];
      readonly named: readonly NamedArg[];
      readonly pos: Pos;
    }
  | { readonly type: "arrow"; readonly params: readonly string[]; readonly body: Expr; readonly pos: Pos };

export type CallExpr = Extract<Expr, { type: "call" }>;
export type ArrowExpr = Extract<Expr, { type: "arrow" }>;

export interface Decl {
  readonly name: string;
  readonly value: Expr;
  readonly pos: Pos;
}

export type Statement =
  | ({ readonly kind: "state" } & Decl)
  | ({ readonly kind: "named" } & Decl)
  | { readonly kind: "root"; readonly value: Expr };

/** A validated program. Only `compile` creates one. */
export interface Program {
  /** `$state` declarations in source order. */
  readonly states: readonly Decl[];
  readonly named: ReadonlyMap<string, Decl>;
  /** Bare expressions in source order, or the named value `root`. */
  readonly roots: readonly Expr[];
}
