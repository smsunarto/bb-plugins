// The Shader component's GPU side: raw WebGL2, Zeron's pipeline. Buffer
// passes render first, in order, into ping-pong float textures (a pass reads
// an earlier buffer's current frame and its own previous one); the image
// pass renders into a float texture too, so light above 1 survives to the
// bloom; a composite pass then puts it on the transparent canvas by blend
// mode, with the bloom added and the edges faded.
//
// WebGL's framebuffer origin is bottom-left like Shadertoy's fragCoord, so
// every pass reads back what it wrote and the canvas shows it upright with
// no flips.
import { describeCompileLog, MAX_TEXTURES, shaderSource, type ShaderPass } from "../../core/glsl";

/** How the output sits on the chat: emitted light (black is clear), its own alpha, or a box. */
export type Blend = "light" | "alpha" | "opaque";

const BLEND_MODE: Record<Blend, number> = { alpha: 0, light: 1, opaque: 2 };

/** Everything a frame draws with besides the compiled passes. */
export interface ShaderFrame {
  /** Device pixels. */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly time: number;
  readonly delta: number;
  readonly frame: number;
  /** Device pixels from the bottom-left: xy pointer, zw where it went down while held (negative otherwise). */
  readonly mouse: readonly [number, number, number, number];
  /** Yaw, pitch, zoom, 0. */
  readonly camera: readonly [number, number, number, number];
  /** One value per input name, in the order compiled. */
  readonly inputs: readonly number[];
  readonly blend: Blend;
  /** 0–3. */
  readonly bloom: number;
}

interface Target {
  readonly texture: WebGLTexture;
  readonly framebuffer: WebGLFramebuffer;
  readonly width: number;
  readonly height: number;
}

interface Pass {
  readonly program: WebGLProgram;
  readonly resolution: WebGLUniformLocation | null;
  readonly time: WebGLUniformLocation | null;
  readonly delta: WebGLUniformLocation | null;
  readonly frame: WebGLUniformLocation | null;
  readonly mouse: WebGLUniformLocation | null;
  readonly camera: WebGLUniformLocation | null;
  readonly channelResolution: WebGLUniformLocation | null;
  readonly inputs: readonly (WebGLUniformLocation | null)[];
}

/** Texture units: iChannel0-3, then the noise, then iTexture0-3. */
const NOISE_UNIT = 4;
const TEXTURE_UNIT = 5;
const NOISE_SIZE = 256;

const FULLSCREEN = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const POST_HEADER = `#version 300 es
precision highp float;
uniform sampler2D source;
uniform vec2 size;
out vec4 color;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
`;

// Soft knee from 0.6, so bright-but-not-clipped light still glows.
const BRIGHT = `${POST_HEADER}
void main() {
  vec3 c = texture(source, gl_FragCoord.xy / size).rgb;
  color = vec4(c * smoothstep(0.6, 1.2, luma(c)), 1.0);
}`;

const BLUR = `${POST_HEADER}
uniform vec2 direction;
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  float w[5] = float[5](0.227, 0.194, 0.121, 0.054, 0.016);
  vec3 sum = texture(source, uv).rgb * w[0];
  for (int k = 1; k < 5; k++) {
    vec2 o = direction / size * float(k) * 1.6;
    sum += (texture(source, uv + o).rgb + texture(source, uv - o).rgb) * w[k];
  }
  color = vec4(sum, 1.0);
}`;

// Premultiplied output for the canvas. Light: brightness is opacity, so
// black is clear. Alpha: the shader's colour is straight over its alpha and
// the glow is light over nothing. Opaque is a deliberate box; the others
// fade out over 15% of the shorter side, as in Zeron.
//
// The canvas holds 8 bits per channel, and dim light (a fading trail, a
// glow's long tail, the edge fade) spans only a few of those levels, which
// shows as hard bands (stripes along the fade). A triangular ±1-level
// dither, the same pattern every frame, turns the bands into grain too fine
// to see. Clear pixels stay exactly clear and opaque ones opaque.
const COMPOSITE = `${POST_HEADER}
uniform sampler2D glow;
uniform float bloom;
uniform int mode;
float ease(float d, float width) {
  float t = clamp(d / width, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}
float ign(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}
void main() {
  vec2 uv = gl_FragCoord.xy / size;
  vec4 c = texture(source, uv);
  vec3 g = bloom > 0.0 ? texture(glow, uv).rgb * bloom : vec3(0.0);
  vec3 rgb = clamp(c.rgb + g, 0.0, 1.0);
  vec4 result;
  if (mode == 2) {
    result = vec4(rgb, 1.0);
  } else {
    float width = max(0.15 * min(size.x, size.y), 1.0);
    vec2 d = min(gl_FragCoord.xy, size - gl_FragCoord.xy);
    float fade = ease(d.x, width) * ease(d.y, width);
    if (mode == 1) {
      result = vec4(rgb, max(rgb.r, max(rgb.g, rgb.b))) * fade;
    } else {
      float a = clamp(c.a + luma(g), 0.0, 1.0);
      result = vec4(min(clamp(c.rgb, 0.0, 1.0) * clamp(c.a, 0.0, 1.0) + g, vec3(a)), a) * fade;
    }
  }
  float n = (ign(gl_FragCoord.xy) + ign(gl_FragCoord.xy + vec2(47.0, 17.0)) - 1.0) / 255.0;
  if (result.a <= 0.0) {
    color = vec4(0.0);
    return;
  }
  float alpha = mode == 2 ? 1.0 : clamp(result.a + n, 0.0, 1.0);
  // Premultiplied colour can't exceed its alpha.
  color = vec4(clamp(result.rgb + n, vec3(0.0), vec3(alpha)), alpha);
}`;

/** Independent random RGBA per texel with Zeron's xorshift and seed, so iNoise is the same everywhere. */
let noiseBytes: Uint8Array | null = null;
function noise(): Uint8Array {
  if (noiseBytes !== null) return noiseBytes;
  noiseBytes = new Uint8Array(NOISE_SIZE * NOISE_SIZE * 4);
  let state = 0x2545f491;
  for (let i = 0; i < noiseBytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    noiseBytes[i] = state >>> 24;
  }
  return noiseBytes;
}

/**
 * One canvas's WebGL2 context and everything on it. Create it while the
 * component holds a GPU slot; `dispose` releases the context at once.
 */
export class ShaderGl {
  /** Float buffers (RGBA16F); false on GPUs without float render targets, which get 8 bits. */
  readonly floatTargets: boolean;
  /** Set when the browser took the context away; nothing draws until a new ShaderGl. */
  lost = false;

  private readonly vertex: WebGLShader;
  private readonly bright: WebGLProgram;
  private readonly blur: WebGLProgram;
  private readonly composite: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly empty: WebGLTexture;
  private readonly noise: WebGLTexture;
  private readonly textures: (WebGLTexture | null)[] = Array.from({ length: MAX_TEXTURES }, () => null);
  /** The last passes that compiled: buffers in order, then the image. */
  private passes: Pass[] | null = null;
  private buffers: [Target, Target][] = [];
  /** Which of each buffer pair holds the latest frame. */
  private latest = 0;
  private image: Target | null = null;
  private bloomTargets: [Target, Target] | null = null;

  /** A ShaderGl on `canvas`, or why there can't be one. */
  static create(canvas: HTMLCanvasElement): ShaderGl | string {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });
    if (gl === null) return "Shaders need WebGL2, which this browser or GPU doesn't offer";
    return new ShaderGl(gl);
  }

  private constructor(private readonly gl: WebGL2RenderingContext) {
    this.floatTargets =
      gl.getExtension("EXT_color_buffer_float") !== null || gl.getExtension("EXT_color_buffer_half_float") !== null;
    this.vertex = this.shader(gl.VERTEX_SHADER, FULLSCREEN);
    this.bright = this.internalProgram(BRIGHT);
    this.blur = this.internalProgram(BLUR);
    this.composite = this.internalProgram(COMPOSITE);
    this.vao = gl.createVertexArray();
    this.empty = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.empty);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    this.noise = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, NOISE_SIZE, NOISE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, noise());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  }

  /**
   * Compiles `passes` (buffers in order, then the image). On an error the
   * previous passes stay, so the last good frame keeps drawing, and the
   * error comes back as "buffer 2, line 7: …".
   */
  compile(passes: readonly ShaderPass[], inputs: readonly string[], textures: number): string | null {
    const { gl } = this;
    const channels = passes.length - 1;
    const compiled: Pass[] = [];
    const fail = (message: string) => {
      for (const pass of compiled) gl.deleteProgram(pass.program);
      return message;
    };
    for (const [index, pass] of passes.entries()) {
      const { source, firstLine } = shaderSource(pass, inputs, channels, textures);
      const fragment = gl.createShader(gl.FRAGMENT_SHADER)!;
      gl.shaderSource(fragment, source);
      gl.compileShader(fragment);
      if (!gl.getShaderParameter(fragment, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(fragment) ?? "";
        gl.deleteShader(fragment);
        return fail(describeCompileLog(log, pass, firstLine));
      }
      const program = gl.createProgram();
      gl.attachShader(program, this.vertex);
      gl.attachShader(program, fragment);
      gl.linkProgram(program);
      gl.deleteShader(fragment);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? "";
        gl.deleteProgram(program);
        return fail(describeCompileLog(log, pass, firstLine));
      }
      gl.useProgram(program);
      for (let channel = 0; channel < channels; channel++) {
        gl.uniform1i(gl.getUniformLocation(program, `iChannel${channel}`), channel);
      }
      gl.uniform1i(gl.getUniformLocation(program, "iNoise"), NOISE_UNIT);
      for (let texture = 0; texture < textures; texture++) {
        gl.uniform1i(gl.getUniformLocation(program, `iTexture${texture}`), TEXTURE_UNIT + texture);
      }
      compiled[index] = {
        program,
        resolution: gl.getUniformLocation(program, "iResolution"),
        time: gl.getUniformLocation(program, "iTime"),
        delta: gl.getUniformLocation(program, "iTimeDelta"),
        frame: gl.getUniformLocation(program, "iFrame"),
        mouse: gl.getUniformLocation(program, "iMouse"),
        camera: gl.getUniformLocation(program, "iCamera"),
        channelResolution: gl.getUniformLocation(program, "iChannelResolution"),
        inputs: inputs.map((name) => gl.getUniformLocation(program, name)),
      };
    }
    for (const pass of this.passes ?? []) gl.deleteProgram(pass.program);
    // A different number of buffers starts the feedback over.
    if (this.passes === null || this.passes.length !== compiled.length) this.dropBuffers();
    this.passes = compiled;
    return null;
  }

  /** The image sampled as iTexture<index> (already flipped so its top is v = 1), or none. */
  setTexture(index: number, image: ImageBitmap | null): void {
    const { gl } = this;
    const previous = this.textures[index];
    if (previous) gl.deleteTexture(previous);
    this.textures[index] = null;
    if (image === null) return;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    this.textures[index] = texture;
  }

  /** Whether there are compiled passes to draw. */
  get ready(): boolean {
    return this.passes !== null && !this.lost;
  }

  /** Runs every pass once and composites onto the canvas (sized by the caller to frame.width × height). */
  draw(frame: ShaderFrame): void {
    const { gl, passes } = this;
    if (passes === null || this.lost) return;
    const { width, height } = frame;
    this.ensureTargets(passes.length - 1, width, height);
    const read = this.latest;
    const write = 1 - read;
    const buffers = passes.length - 1;
    const channelResolution = new Float32Array(12);
    for (let channel = 0; channel < 4; channel++) channelResolution.set([width, height, 1], channel * 3);

    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0 + NOISE_UNIT);
    gl.bindTexture(gl.TEXTURE_2D, this.noise);
    for (let texture = 0; texture < MAX_TEXTURES; texture++) {
      gl.activeTexture(gl.TEXTURE0 + TEXTURE_UNIT + texture);
      gl.bindTexture(gl.TEXTURE_2D, this.textures[texture] ?? this.empty);
    }
    for (const [index, pass] of passes.entries()) {
      const target = index < buffers ? this.buffers[index]![write] : this.image!;
      // Channel j as pass `index` sees it: an earlier buffer's frame from
      // now, its own and later ones' from the last frame.
      for (let channel = 0; channel < 4; channel++) {
        gl.activeTexture(gl.TEXTURE0 + channel);
        const pair = this.buffers[channel];
        gl.bindTexture(gl.TEXTURE_2D, pair === undefined ? this.empty : pair[channel < index ? write : read].texture);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, width, height);
      gl.useProgram(pass.program);
      gl.uniform3f(pass.resolution, width, height, frame.pixelRatio);
      gl.uniform1f(pass.time, frame.time);
      gl.uniform1f(pass.delta, frame.delta);
      gl.uniform1i(pass.frame, frame.frame);
      gl.uniform4fv(pass.mouse, frame.mouse);
      gl.uniform4fv(pass.camera, frame.camera);
      gl.uniform3fv(pass.channelResolution, channelResolution);
      for (const [input, location] of pass.inputs.entries()) gl.uniform1f(location, frame.inputs[input] ?? 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    this.latest = write;

    const bloom = Math.min(3, Math.max(0, frame.bloom));
    const glow = bloom > 0 ? this.drawBloom() : this.empty;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.composite);
    this.bindPostSource(this.composite, this.image!.texture, width, height);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, glow);
    gl.uniform1i(gl.getUniformLocation(this.composite, "glow"), 1);
    gl.uniform1f(gl.getUniformLocation(this.composite, "bloom"), bloom);
    gl.uniform1i(gl.getUniformLocation(this.composite, "mode"), BLEND_MODE[frame.blend]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Frees the GPU now rather than when the canvas is collected (browsers cap live contexts). */
  dispose(): void {
    const { gl } = this;
    if (!this.lost) {
      for (const pass of this.passes ?? []) gl.deleteProgram(pass.program);
      this.dropBuffers();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.lost = true;
    this.passes = null;
  }

  /** The image's bright parts, blurred at half resolution; returns the glow texture. */
  private drawBloom(): WebGLTexture {
    const { gl } = this;
    const [first, second] = this.bloomTargets!;
    const pass = (program: WebGLProgram, source: Target | null, target: Target, direction: [number, number] | null) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
      gl.viewport(0, 0, target.width, target.height);
      gl.useProgram(program);
      this.bindPostSource(program, (source ?? this.image!).texture, target.width, target.height);
      if (direction !== null) gl.uniform2f(gl.getUniformLocation(program, "direction"), ...direction);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    pass(this.bright, null, first, null);
    for (let round = 0; round < 3; round++) {
      pass(this.blur, first, second, [1, 0]);
      pass(this.blur, second, first, [0, 1]);
    }
    return first.texture;
  }

  private bindPostSource(program: WebGLProgram, source: WebGLTexture, width: number, height: number): void {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(gl.getUniformLocation(program, "source"), 0);
    gl.uniform2f(gl.getUniformLocation(program, "size"), width, height);
  }

  /** Buffer pairs, the image and the bloom targets at this size; recreated (cleared) when it changes. */
  private ensureTargets(buffers: number, width: number, height: number): void {
    if (this.image !== null && this.image.width === width && this.image.height === height && this.buffers.length === buffers) {
      return;
    }
    this.dropBuffers();
    this.buffers = Array.from({ length: buffers }, () => [this.target(width, height), this.target(width, height)]);
    this.image = this.target(width, height);
    const half: [number, number] = [Math.max(1, width >> 1), Math.max(1, height >> 1)];
    this.bloomTargets = [this.target(...half), this.target(...half)];
    this.latest = 0;
  }

  private dropBuffers(): void {
    const { gl } = this;
    const targets = [...this.buffers.flat(), ...(this.image ? [this.image] : []), ...(this.bloomTargets ?? [])];
    for (const target of targets) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    this.buffers = [];
    this.image = null;
    this.bloomTargets = null;
  }

  /** A cleared colour target, float where the GPU can render to float. */
  private target(width: number, height: number): Target {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (this.floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return { texture, framebuffer, width, height };
  }

  private shader(type: number, source: string): WebGLShader {
    const { gl } = this;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    // The fixed shaders compile on any WebGL2; a failure is a lost context.
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`Shader setup failed: ${gl.getShaderInfoLog(shader) ?? ""}`);
    }
    return shader;
  }

  private internalProgram(fragmentSource: string): WebGLProgram {
    const { gl } = this;
    const fragment = this.shader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, this.vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(fragment);
    return program;
  }
}
