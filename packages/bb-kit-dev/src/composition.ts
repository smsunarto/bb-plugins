import type * as TS from "typescript";

/** Syntax-only access to a composition root, shared by add and check. */
export function compositionSyntax(ts: typeof TS, sourceFile: TS.SourceFile) {
  const imports = new Map<string, { specifier: string; imported: string; line: number }>();
  const stringText = (node: TS.Node | undefined): string | undefined =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;
  const lineOfNode = (node: TS.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  // Value imports: local name → specifier + imported name.
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }
    const specifier = stringText(statement.moduleSpecifier);
    const clause = statement.importClause;
    if (specifier === undefined || clause === undefined || clause.isTypeOnly) {
      continue;
    }
    const line = lineOfNode(statement);
    const defaultLocal = clause.name?.text;
    if (defaultLocal !== undefined) {
      imports.set(defaultLocal, { specifier, imported: "default", line });
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (element.isTypeOnly) {
          continue;
        }
        const local = element.name.text;
        imports.set(local, {
          specifier,
          imported: element.propertyName?.text ?? local,
          line: lineOfNode(element),
        });
      }
    }
  }
  // Top-level initializers, to chase `const rpc = { ping }`.
  const topInitializers = new Map<string, TS.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined) {
        topInitializers.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  const unwrap = (node: TS.Node | undefined): TS.Node | undefined => {
    let current = node;
    while (
      current !== undefined &&
      (ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current))
    ) {
      current = current.expression;
    }
    return current;
  };
  const namesCalling = (calleeName: string): Set<string> => {
    const names = new Set([calleeName]);
    for (const [local, binding] of imports) {
      if (binding.imported === calleeName) {
        names.add(local);
      }
    }
    return names;
  };
  const resolveCall = (
    node: TS.Node | undefined,
    calleeName: string,
    depth = 0,
  ): TS.CallExpression | undefined => {
    const expression = unwrap(node);
    if (expression === undefined || depth > 5) {
      return undefined;
    }
    if (ts.isCallExpression(expression)) {
      const callee = unwrap(expression.expression);
      return callee !== undefined &&
        ts.isIdentifier(callee) &&
        namesCalling(calleeName).has(callee.text)
        ? expression
        : undefined;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = topInitializers.get(expression.text);
      return initializer !== undefined
        ? resolveCall(initializer, calleeName, depth + 1)
        : undefined;
    }
    return undefined;
  };
  const resolveObjectLiteral = (
    node: TS.Node | undefined,
    depth = 0,
  ): TS.ObjectLiteralExpression | undefined => {
    const expression = unwrap(node);
    if (expression === undefined || depth > 5) {
      return undefined;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression;
    }
    if (ts.isIdentifier(expression)) {
      const initializer = topInitializers.get(expression.text);
      return initializer !== undefined ? resolveObjectLiteral(initializer, depth + 1) : undefined;
    }
    return undefined;
  };
  const propertyKeyOf = (property: TS.ObjectLiteralElementLike): string | undefined => {
    const name = property.name;
    if (name === undefined) {
      return undefined;
    }
    return ts.isIdentifier(name) ? name.text : stringText(name);
  };
  const getProperty = (
    objectLiteral: TS.ObjectLiteralExpression,
    key: string,
  ): TS.ObjectLiteralElementLike | undefined =>
    objectLiteral.properties.find((property) => propertyKeyOf(property) === key);
  const propertyValue = (
    property: TS.ObjectLiteralElementLike | undefined,
  ): TS.Node | undefined => {
    if (property === undefined) {
      return undefined;
    }
    if (ts.isShorthandPropertyAssignment(property)) {
      return property.name;
    }
    if (ts.isPropertyAssignment(property)) {
      return property.initializer;
    }
    return undefined;
  };
  return {
    imports,
    topInitializers,
    unwrap,
    resolveCall,
    resolveObjectLiteral,
    propertyKeyOf,
    getProperty,
    propertyValue,
    stringText,
  };
}
