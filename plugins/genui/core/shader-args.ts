// A Shader's evaluated arguments: its passes in run order, its inputs, and
// what is wrong with their types. core/glsl-check.ts checks the GLSL itself, the
// input names and the pass sizes (checkShader, run by check_ui).
import { MAX_BUFFERS, MAX_TEXTURES, type ShaderPass } from "./glsl";
import { readCamera } from "./scene";
import type { Value } from "./types";

/** The passes in run order: each buffer ("buffer 1" reads as iChannel0), then the image. Non-text buffers are skipped (shaderErrors reports them). */
export function shaderPasses(props: Readonly<Record<string, Value>>): ShaderPass[] {
  const buffers = Array.isArray(props.buffers) ? props.buffers : [];
  return [
    ...buffers.flatMap((code, index) => (typeof code === "string" ? [{ name: `buffer ${index + 1}`, code }] : [])),
    { name: "image", code: typeof props.code === "string" ? props.code : "" },
  ];
}

/** The `inputs` object's entries, or null when `inputs` is not a plain object. */
function inputEntries(props: Readonly<Record<string, Value>>): [string, Value][] | null {
  const inputs = props.inputs;
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs) || "kind" in inputs) return null;
  return Object.entries(inputs as Readonly<Record<string, Value>>);
}

/** The `inputs` names, as checkShader and shaderSource take them. */
export function shaderInputNames(props: Readonly<Record<string, Value>>): string[] {
  return (inputEntries(props) ?? []).map(([name]) => name);
}

/** Why a Shader's evaluated props can't run, besides what checkShader finds in the GLSL. [] when they can. */
export function shaderErrors(props: Readonly<Record<string, Value>>): string[] {
  const errors: string[] = [];
  const buffers = props.buffers ?? [];
  if (Array.isArray(buffers)) {
    if (buffers.length > MAX_BUFFERS) errors.push(`buffers has ${buffers.length} passes; the limit is ${MAX_BUFFERS}`);
    buffers.forEach((code, index) => {
      if (typeof code !== "string") errors.push(`buffers[${index}] must be GLSL text, as in a \`...\` template`);
    });
  }
  const textures = props.textures ?? [];
  if (Array.isArray(textures)) {
    if (textures.length > MAX_TEXTURES) errors.push(`textures has ${textures.length} images; the limit is ${MAX_TEXTURES}`);
    textures.forEach((path, index) => {
      if (typeof path !== "string" || path.trim() === "") errors.push(`textures[${index}] must be an image path`);
    });
  }
  if (props.inputs !== undefined && props.inputs !== null) {
    const entries = inputEntries(props);
    if (entries === null) errors.push("inputs must be an object of name: number, as in {speed: $speed}");
    for (const [name, value] of entries ?? []) {
      if (typeof value !== "number" && typeof value !== "boolean") {
        errors.push(`inputs \`${name}\` must be a number or a boolean, as in {${name}: $${name}}`);
      }
    }
  }
  const camera = readCamera(props.camera).error;
  if (camera !== null) errors.push(camera);
  return errors;
}
