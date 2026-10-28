import { describe, expect, it } from "vitest";
import { checkShader } from "./glsl-check";
import { describeCompileLog, shaderSource, validInputName, type ShaderPass } from "./glsl";

const PLASMA = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float v = sin(uv.x * 10.0 + iTime * speed) + sin(uv.y * 10.0 + iTime);
  fragColor = vec4(0.5 + 0.5 * cos(v + vec3(0.0, 2.0, 4.0)), 1.0);
}`;

const image = (code: string): ShaderPass => ({ name: "image", code });

describe("shaderSource", () => {
  it("places the pass so firstLine maps program lines back to the agent's", () => {
    const pass = image("// one\n// two\nvoid mainImage(out vec4 c, in vec2 p) { c = vec4(1.0); }");
    const { source, firstLine } = shaderSource(pass, ["speed", "glow"], 2, 1);
    const lines = source.split("\n");
    expect(lines[0]).toBe("#version 300 es");
    expect(lines[firstLine - 1]).toBe("// one");
    expect(lines[firstLine + 1]).toContain("void mainImage");
    expect(source).toContain("uniform float speed;");
    expect(source).toContain("uniform sampler2D iChannel1;");
    expect(source).not.toContain("iChannel2;");
    expect(source).toContain("uniform sampler2D iTexture0;");
    expect(source).toContain("mainImage(color, gl_FragCoord.xy);");
  });

  it("blanks the pass's own #version line, keeping its line numbers", () => {
    const { source, firstLine } = shaderSource(image("#version 300 es\nvoid mainImage(out vec4 c, in vec2 p) {}"), [], 0, 0);
    const lines = source.split("\n");
    expect(lines.filter((line) => line.includes("#version"))).toHaveLength(1);
    expect(lines[firstLine - 1]).toBe("");
    expect(lines[firstLine]).toContain("void mainImage");
  });
});

describe("checkShader", () => {
  it("passes a clean Shadertoy shader with its inputs", () => {
    expect(checkShader([image(PLASMA)], ["speed"], 0)).toEqual([]);
  });

  it("passes macros, structs, overloads, buffers, noise and textures", () => {
    const buffer = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = texture(iChannel0, uv) * 0.97 + texture(iNoise, uv * 4.0) * 0.03;
}`;
    const code = `precision highp float;
#define R(a) mat2(cos(a), -sin(a), sin(a), cos(a))
#define LOOP(n) for (int i = 0; i < n; i++)
struct Hit { float d; vec3 n; };
float sdf(vec3 p);
float noise(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
float noise(vec3 p) { return noise(p.xy + p.z); }
Hit march(vec3 ro, vec3 rd) {
  Hit h = Hit(0.0, vec3(0.0));
  LOOP(64) { float d = sdf(ro + rd * h.d); if (d < 0.001) break; h.d += d; }
  return h;
}
float sdf(vec3 p) { p.xz *= R(iTime); return length(p) - 1.0 + 0.1 * noise(p); }
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / min(iResolution.x, iResolution.y);
  Hit h = march(vec3(0.0, 0.0, 3.0 / iCamera.z), normalize(vec3(uv, -1.0)));
  float arr[3];
  for (int i = 0; i < arr.length(); i++) arr[i] = float(i);
  vec4 trail = texelFetch(iChannel0, ivec2(fragCoord), 0) + texture(iTexture0, uv) * iChannelResolution[0].x;
  fragColor = vec4(vec3(h.d < 10.0 ? 1.0 : 0.0), 1.0) + trail * arr[1] + iMouse * float(iFrame) * iTimeDelta;
}`;
    expect(checkShader([{ name: "buffer 1", code: buffer }, image(code)], [], 1)).toEqual([]);
  });

  it("reports a syntax error at the pass and its own line", () => {
    const broken = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv, 0.0 1.0);
}`;
    const [error, ...rest] = checkShader([image(broken)], [], 0);
    expect(error).toMatch(/^image, line 3: syntax error/);
    expect(rest).toEqual([]);
  });

  it("keeps line numbers past #define lines and #if blocks", () => {
    const code = `#define K 2.0
#if 0
garbage (((
#endif
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = vec4(K * nope);
}`;
    expect(checkShader([image(code)], [], 0)).toEqual(["image, line 6: `nope` is not declared"]);
  });

  it("names the buffer pass and explains a channel the Shader doesn't have", () => {
    const buffer = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  fragColor = texture(iChannel1, fragCoord / iResolution.xy);
}`;
    expect(checkShader([{ name: "buffer 1", code: buffer }, image(PLASMA)], ["speed"], 0)).toEqual([
      "buffer 1, line 2: `iChannel1` reads the second buffer, but this Shader has 1 buffer",
    ]);
  });

  it("reports an input the code uses but the Shader doesn't bind", () => {
    expect(checkShader([image(PLASMA)], [], 0)).toEqual(["image, line 3: `speed` is not declared"]);
  });

  it("reports an unclosed block at the pass's last line", () => {
    const [error] = checkShader([image("void mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(1.0);\n")], [], 0);
    expect(error).toMatch(/^image, line 3: .*unclosed/);
  });

  it("rejects input names that are keywords or built-ins, once", () => {
    expect(checkShader([image(PLASMA), image(PLASMA)], ["iTime", "in", "speed"], 0)).toEqual([
      "inputs: `iTime` can't be a shader input (use a GLSL identifier that isn't a keyword or a built-in like iTime)",
      "inputs: `in` can't be a shader input (use a GLSL identifier that isn't a keyword or a built-in like iTime)",
    ]);
    expect(validInputName("speed")).toBe(true);
    expect(validInputName("_k2")).toBe(true);
    expect(validInputName("2k")).toBe(false);
    expect(validInputName("gl_Position")).toBe(false);
  });

  it("requires mainImage", () => {
    expect(checkShader([image("void main() {}")], [], 0)).toEqual([
      "image: define void mainImage(out vec4 fragColor, in vec2 fragCoord)",
    ]);
  });
});

describe("describeCompileLog", () => {
  it("maps a WebGL log to the pass's line", () => {
    const pass = image(PLASMA);
    const { firstLine } = shaderSource(pass, [], 0, 0);
    const log = `ERROR: 0:${firstLine + 2}: 'speed' : undeclared identifier\nERROR: 0:${firstLine + 2}: '*' : wrong operand types`;
    expect(describeCompileLog(log, pass, firstLine)).toBe("image, line 3: 'speed' : undeclared identifier");
    expect(describeCompileLog("link failed", pass, firstLine)).toBe("image: link failed");
  });
});
