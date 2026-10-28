// A Scene's objects, read into checked records with defaults filled, for the
// renderer (every frame when `objects` is a function) and for check_ui. The
// fields and defaults follow Zeron's ui.scene (crates/visual/src/scene.rs);
// unknown fields are errors, as Zeron's unknown props are, so a typo such as
// `colour` is reported instead of silently drawing the default.
import { didYouMean } from "./validate";
import { isFunctionValue, type Value } from "./types";

export type Vec3 = readonly [number, number, number];

export interface Material {
  color: string;
  roughness: number;
  metal: number;
  glow: number;
  glass: boolean;
  ior: number;
  dispersion: number;
  texture: string | null;
}

export type SceneObject =
  | { shape: "box"; at: Vec3; size: Vec3; rotate: Vec3; material: Material }
  | { shape: "sphere"; at: Vec3; radius: number; detail: number; material: Material }
  | { shape: "cylinder"; at: Vec3; radius: number; height: number; detail: number; material: Material }
  | { shape: "surface"; x: [number, number]; z: [number, number]; values: number[][]; colors: string[] | null; wire: boolean; material: Material }
  | { shape: "mesh"; vertices: Vec3[]; faces: [number, number, number][]; uvs: [number, number][] | null; material: Material }
  | { shape: "line"; from: Vec3; to: Vec3; color: string; width: number }
  | { shape: "path"; points: Vec3[]; color: string; width: number }
  | { shape: "point"; at: Vec3; radius: number; color: string; hint: string | null }
  | { shape: "label"; at: Vec3; text: string; color: string; size: "xs" | "sm" | "body" | "lg" }
  | { shape: "grid"; size: number; step: number; y: number }
  | { shape: "axes"; size: number; labels: [string, string, string] | null }
  | { shape: "model"; src: string; at: Vec3; rotate: Vec3; scale: number; fit: number | null; material: Partial<Material> }
  | { shape: "environment"; src: string; intensity: number; background: boolean }
  | { shape: "sprite"; at: Vec3; size: number; color: string; glow: number; src: string | null };

export type Shape = SceneObject["shape"];

/** Theme tokens a 3D colour may name; ui/components/gpu.ts COLOR_TOKENS resolves each. */
export const SCENE_COLORS: Record<string, true> = {
  accent: true, text: true, muted: true, faint: true, border: true, good: true, warn: true, bad: true, info: true,
  chart1: true, chart2: true, chart3: true, chart4: true, chart5: true, chart6: true,
};

/** Past these a scene is an error, not a slow page. */
export const SCENE_LIMITS = { objects: 2_000, meshVertices: 20_000, pathPoints: 2_000, surfaceDetail: 128 } as const;

/** Errors one read reports at most; past that the scene is clearly wrong. */
const MAX_ERRORS = 8;

const MATERIAL_FIELDS = ["color", "roughness", "metal", "glow", "glass", "ior", "dispersion", "texture"] as const;

/** The fields each shape takes besides `shape`. */
const FIELDS: Record<Shape, readonly string[]> = {
  box: ["at", "size", "rotate", ...MATERIAL_FIELDS],
  sphere: ["at", "radius", "detail", ...MATERIAL_FIELDS],
  cylinder: ["at", "radius", "height", "detail", ...MATERIAL_FIELDS],
  surface: ["x", "z", "f", "values", "detail", "colors", "wire", ...MATERIAL_FIELDS],
  mesh: ["vertices", "faces", "uvs", ...MATERIAL_FIELDS],
  line: ["from", "to", "color", "width"],
  path: ["points", "color", "width"],
  point: ["at", "radius", "color", "hint"],
  label: ["at", "text", "color", "size"],
  grid: ["size", "step", "y"],
  axes: ["size", "labels"],
  model: ["src", "at", "rotate", "scale", "fit", ...MATERIAL_FIELDS],
  environment: ["src", "intensity", "background"],
  sprite: ["at", "size", "color", "glow", "src"],
};

const LABEL_SIZES: Record<string, true> = { xs: true, sm: true, body: true, lg: true };

const ORIGIN: Vec3 = [0, 0, 0];

/** A problem with one field; the reader adds which object it is. */
class FieldError extends Error {}

type Fields = { readonly [key: string]: Value };

function isFields(value: Value): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !("kind" in value && typeof value.kind === "string" && ["node", "action", "binding", "function"].includes(value.kind));
}

function describe(value: Value): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return `"${value.length > 24 ? `${value.slice(0, 24)}…` : value}"`;
  if (typeof value === "object") return isFunctionValue(value) ? "a function" : "an object";
  return String(value);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/** One object's fields, read with their defaults; absent and null fields take the default. */
class ObjectReader {
  constructor(private readonly fields: Fields) {}

  has(key: string): boolean {
    return Object.hasOwn(this.fields, key) && this.fields[key] !== null;
  }

  private get(key: string): Value {
    return Object.hasOwn(this.fields, key) ? this.fields[key] : null;
  }

  number(key: string, fallback: number, lo = -Infinity, hi = Infinity): number {
    const value = this.get(key);
    if (value === null) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new FieldError(`\`${key}\` must be a number, got ${describe(value)}`);
    return clamp(value, lo, hi);
  }

  required<T>(key: string, read: (reader: this) => T, example: string): T {
    if (!this.has(key)) throw new FieldError(`needs \`${key}\`, as in ${example}`);
    return read(this);
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.get(key);
    if (value === null) return fallback;
    if (typeof value !== "boolean") throw new FieldError(`\`${key}\` must be true or false, got ${describe(value)}`);
    return value;
  }

  text(key: string): string | null {
    const value = this.get(key);
    if (value === null) return null;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value !== "string") throw new FieldError(`\`${key}\` must be text, got ${describe(value)}`);
    return value;
  }

  path(key: string): string | null {
    const value = this.text(key);
    if (value !== null && value.trim() === "") throw new FieldError(`\`${key}\` needs a file path`);
    return value;
  }

  vec3(key: string, fallback: Vec3): Vec3 {
    const value = this.get(key);
    return value === null ? fallback : vec3(value, `\`${key}\``);
  }

  /** `n` (a cube) or `[w, h, d]`. */
  size(key: string, fallback: number): Vec3 {
    const value = this.get(key);
    if (value === null) return [fallback, fallback, fallback];
    if (typeof value === "number" && Number.isFinite(value)) return [value, value, value];
    return vec3(value, `\`${key}\` (a number or [w, h, d])`);
  }

  range(key: string): [number, number] {
    const value = this.get(key);
    if (value === null) return [-1, 1];
    if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
      throw new FieldError(`\`${key}\` must be [min, max], got ${describe(value)}`);
    }
    return [value[0] as number, value[1] as number];
  }

  color(key: string, fallback: string): string {
    const value = this.get(key);
    return value === null ? fallback : color(value, `\`${key}\``);
  }

  /** The material fields with Zeron's defaults. */
  material(): Material {
    const glass = this.boolean("glass", false);
    const roughness = this.number("roughness", 0.55, 0.02, 1);
    return {
      color: this.color("color", "chart1"),
      // Zeron: glass is always near-polished, or it reads as frosted plastic.
      roughness: glass ? Math.min(roughness, 0.08) : roughness,
      metal: this.number("metal", 0, 0, 1),
      glow: this.number("glow", 0, 0, 8),
      glass,
      ior: this.number("ior", 1.5, 1, 3),
      dispersion: this.number("dispersion", 0, 0, 1),
      texture: this.path("texture"),
    };
  }

  /** Only the material fields the object sets, for a model whose own materials fill the rest. */
  materialOverrides(): Partial<Material> {
    const full = this.material();
    const out: Partial<Material> = {};
    for (const key of MATERIAL_FIELDS) {
      if (this.has(key)) Object.assign(out, { [key]: full[key] });
    }
    if (full.glass && !this.has("roughness")) out.roughness = 0.08;
    return out;
  }
}

function vec3(value: Value, label: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === "number" && Number.isFinite(n))) {
    throw new FieldError(`${label} must be [x, y, z] numbers, got ${describe(value)}`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

function points(value: Value, label: string, limit: number): Vec3[] {
  if (!Array.isArray(value)) throw new FieldError(`${label} must be a list of [x, y, z], got ${describe(value)}`);
  if (value.length > limit) throw new FieldError(`${label} has ${value.length} points; the limit is ${limit}`);
  return value.map((item, index) => vec3(item, `${label}[${index}]`));
}

function color(value: Value, label: string): string {
  if (typeof value === "string") {
    if (Object.hasOwn(SCENE_COLORS, value)) return value;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
    if (hex !== undefined) return `#${(hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex).toLowerCase()}`;
  }
  throw new FieldError(`${label} must be a theme colour (${Object.keys(SCENE_COLORS).join(", ")}) or "#rrggbb", got ${describe(value)}`);
}

/** Calls a surface's `f` on a (detail + 1)² grid; rows run along z. */
function sample(f: Value, x: [number, number], z: [number, number], detail: number): number[][] {
  if (!isFunctionValue(f)) throw new FieldError(`\`f\` must be a function such as (x, z) => sin(x) * cos(z), got ${describe(f)}`);
  const rows: number[][] = [];
  for (let j = 0; j <= detail; j++) {
    const zj = z[0] + ((z[1] - z[0]) * j) / detail;
    const row: number[] = [];
    for (let i = 0; i <= detail; i++) {
      const xi = x[0] + ((x[1] - x[0]) * i) / detail;
      const { value, error } = f.call([xi, zj]);
      const at = `f(${round(xi)}, ${round(zj)})`;
      if (error !== null) throw new FieldError(`${at} failed: ${error}`);
      if (typeof value !== "number" || !Number.isFinite(value)) throw new FieldError(`${at} must return a number, got ${describe(value)}`);
      row.push(value);
    }
    rows.push(row);
  }
  return rows;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function grid(value: Value): number[][] {
  const max = SCENE_LIMITS.surfaceDetail + 1;
  const rows = Array.isArray(value) ? value : null;
  if (rows === null || rows.length < 2 || !rows.every((row) => Array.isArray(row) && row.length >= 2)) {
    throw new FieldError("`values` must be rows of heights, at least 2×2, as in [[0, 1], [1, 2]]");
  }
  const width = (rows[0] as readonly Value[]).length;
  if (rows.length > max || width > max) throw new FieldError(`\`values\` is ${rows.length}×${width}; the limit is ${max}×${max}`);
  return rows.map((row, j) => {
    const cells = row as readonly Value[];
    if (cells.length !== width) throw new FieldError(`\`values\` rows must all have ${width} heights; row ${j} has ${cells.length}`);
    return cells.map((cell, i) => {
      if (typeof cell !== "number" || !Number.isFinite(cell)) throw new FieldError(`\`values\`[${j}][${i}] must be a number, got ${describe(cell)}`);
      return cell;
    });
  });
}

function mesh(fields: ObjectReader, raw: Fields): SceneObject {
  const vertices = fields.required("vertices", () => points(raw.vertices, "`vertices`", SCENE_LIMITS.meshVertices), "vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]]");
  const faceList = fields.required("faces", () => raw.faces, "faces: [[0, 1, 2]]");
  if (!Array.isArray(faceList)) throw new FieldError(`\`faces\` must be a list of [i, j, k] vertex indexes, got ${describe(faceList)}`);
  const faces: [number, number, number][] = [];
  faceList.forEach((face, index) => {
    const indexes = Array.isArray(face) ? face : [];
    const valid = indexes.length >= 3 && indexes.every((n) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < vertices.length);
    if (!valid) {
      throw new FieldError(`\`faces\`[${index}] must be 3 or more vertex indexes from 0 to ${vertices.length - 1}, got ${describe(face)}`);
    }
    const corners = indexes as readonly number[];
    // A polygon fans into triangles around its first corner, as Zeron's do.
    for (let k = 1; k < corners.length - 1; k++) faces.push([corners[0], corners[k], corners[k + 1]]);
  });
  let uvs: [number, number][] | null = null;
  if (fields.has("uvs")) {
    const list = raw.uvs;
    if (!Array.isArray(list) || list.length !== vertices.length) {
      throw new FieldError(`\`uvs\` must be one [u, v] per vertex (${vertices.length})`);
    }
    uvs = list.map((uv, index) => {
      if (!Array.isArray(uv) || uv.length !== 2 || !uv.every((n) => typeof n === "number" && Number.isFinite(n))) {
        throw new FieldError(`\`uvs\`[${index}] must be [u, v], got ${describe(uv)}`);
      }
      return [uv[0] as number, uv[1] as number];
    });
  }
  return { shape: "mesh", vertices, faces, uvs, material: fields.material() };
}

function readObject(raw: Fields, shape: Shape): SceneObject {
  const fields = new ObjectReader(raw);
  const at = (example: string) => fields.required("at", () => fields.vec3("at", ORIGIN), example);
  switch (shape) {
    case "box":
      return { shape, at: at("at: [0, 0.5, 0]"), size: fields.size("size", 1), rotate: fields.vec3("rotate", ORIGIN), material: fields.material() };
    case "sphere":
      return {
        shape,
        at: at("at: [0, 1, 0]"),
        radius: Math.abs(fields.number("radius", 0.5)),
        detail: Math.round(fields.number("detail", 18, 6, 48)),
        material: fields.material(),
      };
    case "cylinder":
      return {
        shape,
        at: at("at: [0, 0, 0] (the base centre)"),
        radius: Math.abs(fields.number("radius", 0.5)),
        height: fields.number("height", 1),
        detail: Math.round(fields.number("detail", 24, 6, 64)),
        material: fields.material(),
      };
    case "surface": {
      const x = fields.range("x");
      const z = fields.range("z");
      const detail = Math.round(fields.number("detail", 32, 2));
      if (detail > SCENE_LIMITS.surfaceDetail) throw new FieldError(`\`detail\` is ${detail}; the limit is ${SCENE_LIMITS.surfaceDetail}`);
      if (fields.has("f") === fields.has("values")) {
        throw new FieldError("needs either `f: (x, z) => height` or `values: [[...], ...]` (rows along z)");
      }
      const colorList = raw.colors;
      let colors: string[] | null = null;
      if (fields.has("colors")) {
        if (!Array.isArray(colorList) || colorList.length === 0) throw new FieldError("`colors` must be a list of colours, low to high");
        colors = colorList.map((item, index) => color(item, `\`colors\`[${index}]`));
      }
      const values = fields.has("f") ? sample(raw.f, x, z, detail) : grid(raw.values);
      return { shape, x, z, values, colors, wire: fields.boolean("wire", false), material: fields.material() };
    }
    case "mesh":
      return mesh(fields, raw);
    case "line":
      return {
        shape,
        from: fields.required("from", () => fields.vec3("from", ORIGIN), "from: [0, 0, 0], to: [1, 1, 0]"),
        to: fields.required("to", () => fields.vec3("to", ORIGIN), "from: [0, 0, 0], to: [1, 1, 0]"),
        color: fields.color("color", "muted"),
        width: fields.number("width", 1, 0.25, 12),
      };
    case "path": {
      const list = fields.required("points", () => points(raw.points, "`points`", SCENE_LIMITS.pathPoints), "points: [[0, 0, 0], [1, 1, 0]]");
      if (list.length < 2) throw new FieldError("`points` needs at least 2 points");
      return { shape, points: list, color: fields.color("color", "muted"), width: fields.number("width", 1, 0.25, 12) };
    }
    case "point":
      return {
        shape,
        at: at("at: [1, 2, 0]"),
        radius: fields.number("radius", 3, 0.5, 24),
        color: fields.color("color", "chart1"),
        hint: fields.text("hint"),
      };
    case "label": {
      const size = fields.text("size") ?? "xs";
      if (!Object.hasOwn(LABEL_SIZES, size)) throw new FieldError(`\`size\` must be one of xs, sm, body, lg, got "${size}"`);
      return {
        shape,
        at: at("at: [0, 1.2, 0]"),
        text: fields.required("text", () => fields.text("text") ?? "", 'text: "Peak"'),
        color: fields.color("color", "muted"),
        size: size as "xs" | "sm" | "body" | "lg",
      };
    }
    case "grid":
      return {
        shape,
        size: Math.max(0.1, Math.abs(fields.number("size", 10))),
        step: Math.max(0.01, Math.abs(fields.number("step", 1))),
        y: fields.number("y", 0),
      };
    case "axes": {
      let labels: [string, string, string] | null = null;
      if (fields.has("labels")) {
        const list = raw.labels;
        if (!Array.isArray(list) || list.length !== 3) throw new FieldError('`labels` must be 3 names, as in ["x", "y", "z"]');
        labels = [String(list[0] ?? ""), String(list[1] ?? ""), String(list[2] ?? "")];
      }
      return { shape, size: fields.number("size", 1), labels };
    }
    case "model": {
      const fit = fields.has("fit") ? Math.abs(fields.number("fit", 1)) : null;
      return {
        shape,
        src: fields.required("src", () => fields.path("src")!, 'src: "chair.glb"'),
        at: fields.vec3("at", ORIGIN),
        rotate: fields.vec3("rotate", ORIGIN),
        scale: fields.number("scale", 1),
        fit,
        material: fields.materialOverrides(),
      };
    }
    case "environment":
      return {
        shape,
        src: fields.required("src", () => fields.path("src")!, 'src: "studio.hdr"'),
        intensity: fields.number("intensity", 1, 0, 16),
        background: fields.boolean("background", false),
      };
    case "sprite":
      return {
        shape,
        at: at("at: [0, 2, 0]"),
        size: fields.number("size", 48, 1, 2048),
        color: fields.color("color", "chart1"),
        glow: fields.number("glow", 1, 0, 16),
        src: fields.path("src"),
      };
  }
}

/** Nested lists flatten (a `map` inside the list) and null/false drop out (`show ? {...} : null`), as children do. */
function flatten(value: readonly Value[], out: Value[]): Value[] {
  for (const item of value) {
    if (Array.isArray(item)) flatten(item, out);
    else if (item !== null && item !== false) out.push(item);
  }
  return out;
}

/** Reads the objects at time t (calls the function when `objects` is one; samples surface `f` into `values`). Never throws. */
export function readScene(objects: Value, t: number): { objects: SceneObject[]; errors: string[] } {
  let list: Value = objects;
  if (isFunctionValue(objects)) {
    const { value, error } = objects.call([t]);
    if (error !== null) return { objects: [], errors: [`objects(t) failed: ${error}`] };
    list = value;
  }
  if (!Array.isArray(list)) {
    const got = isFunctionValue(objects) ? `the function returned ${describe(list)}` : `got ${describe(list)}`;
    return { objects: [], errors: [`objects must be a list of {shape, ...} objects or a function t => [...]; ${got}`] };
  }
  const items = flatten(list, []);
  if (items.length > SCENE_LIMITS.objects) {
    return { objects: [], errors: [`the scene has ${items.length} objects; the limit is ${SCENE_LIMITS.objects}`] };
  }
  const read: SceneObject[] = [];
  const errors: string[] = [];
  for (const [index, item] of items.entries()) {
    if (errors.length >= MAX_ERRORS) break;
    if (!isFields(item)) {
      errors.push(`object ${index}: must be an object such as {shape: "sphere", at: [0, 1, 0]}, got ${describe(item)}`);
      continue;
    }
    // isFields excluded interpreter output; TypeScript can't drop Action by its `kind` (an index signature has one too).
    const record = item as Fields;
    const shape = record.shape;
    if (typeof shape !== "string" || !Object.hasOwn(FIELDS, shape)) {
      const hint = typeof shape === "string" ? didYouMean(shape, Object.keys(FIELDS)) : "";
      errors.push(`object ${index}: \`shape\` must be one of ${Object.keys(FIELDS).join(", ")}; got ${describe(shape ?? null)}.${hint}`);
      continue;
    }
    const known = FIELDS[shape as Shape];
    const unknown = Object.keys(item).filter((key) => key !== "shape" && !known.includes(key));
    if (unknown.length > 0) {
      for (const key of unknown) {
        const hint = didYouMean(key, known) || ` ${shape} takes ${known.join(", ")}.`;
        errors.push(`object ${index} (${shape}): unknown field \`${key}\`.${hint}`);
      }
      continue;
    }
    try {
      read.push(readObject(record, shape as Shape));
    } catch (error) {
      if (!(error instanceof FieldError)) throw error;
      errors.push(`object ${index} (${shape}): ${error.message}`);
    }
  }
  return { objects: read, errors };
}

/** Every file path the scene names (model/environment/sprite src, textures), for loading and checks. */
export function sceneAssets(objects: readonly SceneObject[]): string[] {
  const found = new Set<string>();
  for (const object of objects) {
    if ("src" in object && object.src !== null) found.add(object.src);
    if ("material" in object && typeof object.material.texture === "string") found.add(object.material.texture);
  }
  return [...found];
}

export interface Camera {
  readonly yaw: number;
  readonly pitch: number;
  readonly zoom: number;
}

const CAMERA_DEFAULTS: Camera = { yaw: 0.6, pitch: 0.45, zoom: 1 };

/** A Scene's or Shader's `camera` with its defaults, or why it is wrong. */
export function readCamera(value: Value | undefined): { camera: Camera; error: string | null } {
  if (value === undefined || value === null) return { camera: CAMERA_DEFAULTS, error: null };
  if (!isFields(value)) return { camera: CAMERA_DEFAULTS, error: `camera must be {yaw?, pitch?, zoom?}, got ${describe(value)}` };
  const unknown = Object.keys(value).find((key) => !Object.hasOwn(CAMERA_DEFAULTS, key));
  if (unknown !== undefined) {
    const hint = didYouMean(unknown, Object.keys(CAMERA_DEFAULTS)) || " It takes yaw, pitch and zoom.";
    return { camera: CAMERA_DEFAULTS, error: `camera has no field \`${unknown}\`.${hint}` };
  }
  try {
    const fields = new ObjectReader(value);
    return {
      camera: { yaw: fields.number("yaw", CAMERA_DEFAULTS.yaw), pitch: fields.number("pitch", CAMERA_DEFAULTS.pitch), zoom: fields.number("zoom", CAMERA_DEFAULTS.zoom) },
      error: null,
    };
  } catch (error) {
    if (!(error instanceof FieldError)) throw error;
    return { camera: CAMERA_DEFAULTS, error: `camera ${error.message}` };
  }
}

/** Why a Scene's evaluated props can't be drawn at time t: its camera, then its objects. [] when it can. */
export function sceneErrors(props: Readonly<Record<string, Value>>, t: number): string[] {
  const camera = readCamera(props.camera).error;
  return [...(camera === null ? [] : [camera]), ...readScene(props.objects ?? null, t).errors];
}
