// check_ui's pre-check of a Shader's GLSL, without a GPU: each pass is
// wrapped as the renderer compiles it (glsl.ts) and parsed, so a syntax
// error or a misspelled name reaches the agent at its own pass and line
// before the reader sees the block. Server-side only: the parser is ~600 KB
// and nothing the app bundles may import this file.
import { atPassLine, MAX_INPUTS, MAX_SHADER_BYTES, shaderSource, validInputName, type ShaderPass } from "./glsl";
import { parse, preprocess, type GlslLocation, type GlslParseError, type GlslProgram } from "./glsl-parser.js";

/**
 * Syntax errors and undeclared names per pass, as "buffer 1, line 7:
 * <message>" (the line within the agent's pass). [] when clean. `passes`
 * are the buffers and the image; every buffer is a channel of every pass.
 */
export function checkShader(passes: readonly ShaderPass[], inputs: readonly string[], textures: number): string[] {
  const errors: string[] = [];
  const badInputs = inputs.filter((name) => !validInputName(name) || !parses(`uniform float ${name};`));
  for (const name of badInputs) {
    errors.push(`inputs: \`${name}\` can't be a shader input (use a GLSL identifier that isn't a keyword or a built-in like iTime)`);
  }
  if (inputs.length > MAX_INPUTS) errors.push(`inputs: at most ${MAX_INPUTS} (got ${inputs.length})`);
  // A bad input name breaks every pass's header the same way: reported once above.
  if (badInputs.length > 0) return errors;
  const channels = passes.filter((pass) => pass.name !== "image").length;
  for (const pass of passes) errors.push(...checkPass(pass, inputs, channels, textures));
  return errors;
}

function checkPass(pass: ShaderPass, inputs: readonly string[], channels: number, textures: number): string[] {
  const bytes = new TextEncoder().encode(pass.code).length;
  if (bytes > MAX_SHADER_BYTES) {
    return [`${pass.name}: a pass is at most ${MAX_SHADER_BYTES / 1024} KiB (this one is ${Math.ceil(bytes / 1024)} KiB)`];
  }
  if (!/\bmainImage\b/.test(pass.code)) {
    return [`${pass.name}: define void mainImage(out vec4 fragColor, in vec2 fragCoord)`];
  }
  const { source, firstLine } = shaderSource(pass, inputs, channels, textures);

  // Shadertoy code leans on #define; the parser needs it expanded. The
  // preprocessor drops directive lines, so each other line carries its
  // program line number in a trailing comment that survives expansion.
  let continued = false;
  const marked = source
    .split("\n")
    .map((line, index) => {
      const directive = continued || /^\s*#/.test(line);
      continued = directive && /\\\s*$/.test(line);
      return directive ? line : `${line} //@${index + 1}`;
    })
    .join("\n");
  let expanded: string;
  try {
    expanded = preprocess(marked, { preserveComments: true });
  } catch (cause) {
    return [`${pass.name}: ${String(cause instanceof Error ? cause.message : cause).split("\n")[0]}`];
  }
  const expandedLines = expanded.split("\n");
  /** The program line an expanded line came from: its marker, or the nearest one above. */
  const programLine = (line: number) => {
    for (let index = Math.min(line, expandedLines.length) - 1; index >= 0; index--) {
      const marker = /\/\/@(\d+)\s*$/.exec(expandedLines[index]!);
      if (marker !== null) return Number(marker[1]);
    }
    return 0;
  };

  let program: GlslProgram;
  try {
    program = parse(expanded, { stage: "fragment", quiet: true, includeLocation: true });
  } catch (cause) {
    if (cause instanceof Error && "location" in cause && "found" in cause) {
      // Peggy's error, typed in glsl-parser.d.ts; the check above is what tells it from a crash.
      const error = cause as GlslParseError;
      return [atPassLine(pass, firstLine, programLine(error.location.start.line), syntaxMessage(error))];
    }
    return [`${pass.name}: ${String(cause instanceof Error ? cause.message : cause).split("\n")[0]}`];
  }

  // The parser records every name it couldn't resolve as a scope entry
  // without a declaration. Built-in functions never get an entry; built-in
  // variables (gl_*) do, so they are skipped. Its scoping misses some valid
  // GLSL (`arr.length()` in a for header), so a name declared anywhere in
  // the program counts as declared: a scope mistake is left to the real
  // compile, which the renderer reports at the same line.
  const declared = new Set<string>();
  const unresolved: { name: string; location: GlslLocation | undefined }[] = [];
  for (const scope of program.scopes) {
    for (const [name, entry] of [...Object.entries(scope.bindings), ...Object.entries(scope.types)]) {
      if (entry.declaration !== undefined) declared.add(name);
      else if (!name.startsWith("gl_")) unresolved.push({ name, location: entry.references[0]?.location });
    }
    for (const [name, overloads] of Object.entries(scope.functions)) {
      // Overload matching guesses at argument types, so a call it can't
      // match is fine when any overload (or a prototype) of the name exists.
      const all = Object.values(overloads);
      const defined = all.some(
        (overload) =>
          overload.declaration !== undefined ||
          overload.references.some((reference) => reference.type === "function_prototype"),
      );
      if (defined) declared.add(name);
      else unresolved.push({ name, location: all[0]?.references[0]?.location });
    }
  }
  const undeclared = new Map<string, number>();
  for (const { name, location } of unresolved) {
    if (declared.has(name)) continue;
    const line = location === undefined ? 0 : programLine(location.start.line);
    const seen = undeclared.get(name);
    if (seen === undefined || (line > 0 && line < seen)) undeclared.set(name, line);
  }
  return [...undeclared]
    .sort(([, a], [, b]) => a - b)
    .map(([name, line]) => atPassLine(pass, firstLine, line, undeclaredMessage(name, channels, textures)));
}

const ORDINALS = ["first", "second", "third", "fourth"];

function undeclaredMessage(name: string, channels: number, textures: number): string {
  const channel = /^iChannel(\d)$/.exec(name);
  if (channel !== null) {
    const index = Number(channel[1]);
    return `\`${name}\` reads the ${ORDINALS[index] ?? `#${index + 1}`} buffer, but this Shader has ${channels === 1 ? "1 buffer" : `${channels} buffers`}`;
  }
  const texture = /^iTexture(\d)$/.exec(name);
  if (texture !== null) {
    const index = Number(texture[1]);
    return `\`${name}\` is the ${ORDINALS[index] ?? `#${index + 1}`} path in textures, but this Shader has ${textures === 1 ? "1 texture" : `${textures} textures`}`;
  }
  return `\`${name}\` is not declared`;
}

/**
 * Peggy's error ("Expected …, or … but … found.") points at the furthest
 * place any grammar rule reached, which is near the mistake rather than on
 * it, and its expectations name grammar rules: keep the line and what was
 * found.
 */
function syntaxMessage(error: GlslParseError): string {
  return error.found === null ? "syntax error: the code ends early" : `syntax error near "${error.found}"`;
}

/** Whether `source` parses: an input name that is a GLSL keyword doesn't. */
function parses(source: string): boolean {
  try {
    parse(source, { quiet: true });
    return true;
  } catch {
    return false;
  }
}
