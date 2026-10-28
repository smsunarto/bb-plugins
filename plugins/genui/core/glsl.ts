// Shader passes as WebGL2 compiles them. Agents write Shadertoy-style
// passes (`void mainImage(out vec4 fragColor, in vec2 fragCoord)`);
// `shaderSource` wraps one in a complete GLSL ES 3.00 fragment program with
// the inputs Shadertoy and Zeron provide, and `describeCompileLog` maps the
// browser's compile log back to the agent's pass and line. The renderer
// imports this file, so it stays free of the GLSL parser (~600 KB):
// check_ui's GPU-less pre-check is glsl-check.ts.

/** Buffer passes before the image pass. */
export const MAX_BUFFERS = 4;
/** Images a shader samples as iTexture0-3. */
export const MAX_TEXTURES = 4;
/** Named float inputs. */
export const MAX_INPUTS = 16;
/** Longest source of one pass, in UTF-8 bytes. */
export const MAX_SHADER_BYTES = 64 * 1024;

/** One pass of a Shader: "image", or "buffer 1"… for the buffers (buffer i is iChannel<i-1>). */
export interface ShaderPass {
  readonly name: string;
  readonly code: string;
}

/** The output the generated main() writes; agents' names can't collide with the prefix. */
const OUTPUT = "genui_color";

/** Names the program declares itself: an input may not shadow them. */
const RESERVED_NAMES: Record<string, true> = {
  iResolution: true,
  iTime: true,
  iTimeDelta: true,
  iFrame: true,
  iMouse: true,
  iCamera: true,
  iChannelResolution: true,
  iNoise: true,
  iChannel0: true,
  iChannel1: true,
  iChannel2: true,
  iChannel3: true,
  iTexture0: true,
  iTexture1: true,
  iTexture2: true,
  iTexture3: true,
  main: true,
  mainImage: true,
};

/**
 * Whether `name` can be a shader input: a GLSL identifier that shadows no
 * built-in input. Keywords pass here; checkShader (glsl-check.ts) rejects
 * them with the parser, which knows all ~150.
 */
export function validInputName(name: string): boolean {
  return (
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
    !name.startsWith("gl_") &&
    !name.startsWith("genui_") &&
    !name.includes("__") &&
    RESERVED_NAMES[name] !== true
  );
}

/**
 * The complete fragment program for `pass`, and `firstLine`: the 1-based line
 * of the program where the pass's line 1 sits (pass line = program line -
 * firstLine + 1). `channels` buffers are declared as iChannel0…, `textures`
 * images as iTexture0…; sampling one the Shader doesn't have is an
 * undeclared name, not a silent black texture.
 */
export function shaderSource(
  pass: ShaderPass,
  inputs: readonly string[],
  channels: number,
  textures: number,
): { source: string; firstLine: number } {
  const header = [
    "#version 300 es",
    "precision highp float;",
    "precision highp int;",
    "precision highp sampler2D;",
    "uniform vec3 iResolution;",
    "uniform float iTime;",
    "uniform float iTimeDelta;",
    "uniform int iFrame;",
    "uniform vec4 iMouse;",
    "uniform vec4 iCamera;",
    "uniform vec3 iChannelResolution[4];",
    "uniform sampler2D iNoise;",
    ...Array.from({ length: Math.min(channels, MAX_BUFFERS) }, (_, i) => `uniform sampler2D iChannel${i};`),
    ...Array.from({ length: Math.min(textures, MAX_TEXTURES) }, (_, i) => `uniform sampler2D iTexture${i};`),
    ...inputs.slice(0, MAX_INPUTS).map((name) => `uniform float ${name};`),
    `out vec4 ${OUTPUT};`,
  ];
  // The program has its own #version, which must be the first line; the
  // pass's one (Shadertoy code often carries it) becomes blank, keeping
  // every other line where the agent wrote it.
  const body = pass.code.replace(/^[ \t]*#[ \t]*version\b.*$/gm, "");
  const source = [
    ...header,
    body,
    "void main() {",
    "  vec4 color = vec4(0.0, 0.0, 0.0, 1.0);",
    "  mainImage(color, gl_FragCoord.xy);",
    `  ${OUTPUT} = color;`,
    "}",
    "",
  ].join("\n");
  return { source, firstLine: header.length + 1 };
}

/**
 * A WebGL compile or link log ("ERROR: 0:12: 'nope' : undeclared
 * identifier") as "image, line 3: 'nope' : undeclared identifier": the first
 * error, at the pass's own line, for the renderer's ErrorLine.
 */
export function describeCompileLog(log: string, pass: ShaderPass, firstLine: number): string {
  const match = /ERROR:\s*\d+:(\d+):\s*(.*)/.exec(log);
  if (match === null) return `${pass.name}: ${log.trim().split("\n")[0] || "the shader failed to compile"}`;
  return atPassLine(pass, firstLine, Number(match[1]), match[2]!.trim());
}

/** `message` about line `programLine` of the program, told at the pass's own line. */
export function atPassLine(pass: ShaderPass, firstLine: number, programLine: number, message: string): string {
  const line = programLine - firstLine + 1;
  if (line < 1) return `${pass.name}: ${message}`;
  const passLines = pass.code.split("\n").length;
  // Past the pass is the generated main(): the pass left a block or call open.
  if (line > passLines) return `${pass.name}, line ${passLines}: ${message} (an unclosed "{" or "(" before the end?)`;
  return `${pass.name}, line ${line}: ${message}`;
}
