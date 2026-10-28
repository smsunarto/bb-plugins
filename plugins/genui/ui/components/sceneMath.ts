// The Scene renderer's arithmetic, kept free of three.js and the DOM so it
// can be tested: where the camera stands (framed on the geometry as Zeron
// frames it), how far the geometry reaches, and the surface grid.
import type { SceneObject, Vec3 } from "../../core/scene";

/** The reader's view: turntable angle, tilt (radians) and zoom. */
export interface Orbit {
  yaw: number;
  pitch: number;
  zoom: number;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

/** Just short of straight down or up, where the turntable would flip. */
export const MAX_PITCH = 1.52;
export const MIN_ZOOM = 0.2;
export const MAX_ZOOM = 8;

export interface CameraView {
  eye: Vec3;
  target: Vec3;
  /** Vertical field of view, degrees. */
  fov: number;
  near: number;
  far: number;
  /** The geometry's bounding radius, for lights and shadows. */
  radius: number;
}

/**
 * The camera framed on `bounds` and orbited to `orbit`, for a canvas `width`
 * by `height` (Zeron's framing): the eye sits four bounding radii out, and the
 * lens fits the footprint's radius sideways and its height plus the tilted
 * footprint vertically. Neither depends on yaw, so a spinning scene keeps its size.
 */
export function frameCamera(bounds: Bounds | null, orbit: Orbit, width: number, height: number): CameraView {
  const { min, max } = bounds ?? { min: [-1, -1, -1], max: [1, 1, 1] };
  const target: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const half: Vec3 = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2];
  const radius = Math.max(Math.hypot(...half), 1e-3);
  const pitch = Math.min(MAX_PITCH, Math.max(-MAX_PITCH, orbit.pitch));
  const footprint = Math.max(Math.hypot(half[0], half[2]), 1e-3);
  const tall = Math.max(half[1] * Math.abs(Math.cos(pitch)) + footprint * Math.abs(Math.sin(pitch)), 1e-3);
  const distance = radius * 4;
  const eye: Vec3 = [
    target[0] + distance * Math.cos(pitch) * Math.sin(orbit.yaw),
    target[1] + distance * Math.sin(pitch),
    target[2] + distance * Math.cos(pitch) * Math.cos(orbit.yaw),
  ];
  // Pixels per unit at unit depth; the margin (0.86) keeps the geometry off the faded edges.
  const focal =
    0.86 * Math.min(width / 2 / footprint, height / 2 / tall) * distance * Math.max(orbit.zoom, 0.05);
  const fov = (2 * Math.atan(height / 2 / focal) * 180) / Math.PI;
  return { eye, target, fov, near: distance * 0.02, far: distance + radius * 6, radius };
}

/** The rotation `rotate` (degrees, about x, then y, then z) as rows. */
export function rotationRows([x, y, z]: Vec3): [Vec3, Vec3, Vec3] {
  const [a, b, c] = [x, y, z].map((degrees) => (degrees * Math.PI) / 180);
  const [ca, sa, cb, sb, cc, sc] = [Math.cos(a), Math.sin(a), Math.cos(b), Math.sin(b), Math.cos(c), Math.sin(c)];
  // Rz · Ry · Rx
  return [
    [cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa],
    [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa],
    [-sb, cb * sa, cb * ca],
  ];
}

/**
 * How far the drawn geometry reaches, for framing. Models are measured once
 * loaded (the renderer adds them); environments have no extent. Null when
 * nothing has one.
 */
export function sceneBounds(objects: readonly SceneObject[]): Bounds | null {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const grow = (x: number, y: number, z: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
    max[2] = Math.max(max[2], z);
  };
  const around = ([x, y, z]: Vec3, [hx, hy, hz]: Vec3) => {
    grow(x - hx, y - hy, z - hz);
    grow(x + hx, y + hy, z + hz);
  };
  for (const object of objects) {
    switch (object.shape) {
      case "box": {
        // The rotated box's axis-aligned extent: each half-size axis projected onto x, y, z.
        const rows = rotationRows(object.rotate);
        const half = object.size.map((side) => Math.abs(side) / 2);
        const [rx, ry, rz] = rows.map((row) => Math.abs(row[0]) * half[0] + Math.abs(row[1]) * half[1] + Math.abs(row[2]) * half[2]);
        around(object.at, [rx, ry, rz]);
        break;
      }
      case "sphere":
        around(object.at, [object.radius, object.radius, object.radius]);
        break;
      case "cylinder": {
        const [x, y, z] = object.at;
        grow(x - object.radius, y, z - object.radius);
        grow(x + object.radius, y + object.height, z + object.radius);
        break;
      }
      case "surface": {
        let low = Infinity;
        let high = -Infinity;
        for (const row of object.values) {
          for (const value of row) {
            if (!Number.isFinite(value)) continue;
            low = Math.min(low, value);
            high = Math.max(high, value);
          }
        }
        if (low > high) break;
        grow(object.x[0], low, object.z[0]);
        grow(object.x[1], high, object.z[1]);
        break;
      }
      case "mesh":
        for (const [x, y, z] of object.vertices) grow(x, y, z);
        break;
      case "line":
        grow(...object.from);
        grow(...object.to);
        break;
      case "path":
        for (const [x, y, z] of object.points) grow(x, y, z);
        break;
      case "point":
      case "label":
      case "sprite":
        grow(...object.at);
        break;
      case "grid":
        grow(-object.size / 2, object.y, -object.size / 2);
        grow(object.size / 2, object.y, object.size / 2);
        break;
      case "axes":
        grow(0, 0, 0);
        grow(object.size, object.size, object.size);
        break;
      case "model":
      case "environment":
        break;
    }
  }
  return min[0] <= max[0] ? { min, max } : null;
}

type Rows = readonly [Vec3, Vec3, Vec3];

// three's ACES Filmic tone mapping (ShaderChunk tonemapping_pars_fragment), as rows.
const ACES_IN: Rows = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
const ACES_OUT: Rows = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];
/** three brightens by 1 / 0.6 before the curve ("a brighter viewing environment"). */
const ACES_EXPOSURE = 1 / 0.6;

function times(rows: Rows, [x, y, z]: Vec3): [number, number, number] {
  return [rows[0][0] * x + rows[0][1] * y + rows[0][2] * z, rows[1][0] * x + rows[1][1] * y + rows[1][2] * z, rows[2][0] * x + rows[2][1] * y + rows[2][2] * z];
}

function inverse([[a, b, c], [d, e, f], [g, h, i]]: Rows): Rows {
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

const ACES_IN_INVERSE = inverse(ACES_IN);
const ACES_OUT_INVERSE = inverse(ACES_OUT);

/** three's ACES Filmic tone mapping of a linear colour (exposure 1), before the clamp. */
export function acesFilmic(color: Vec3): [number, number, number] {
  const [r, g, b] = times(ACES_IN, [color[0] * ACES_EXPOSURE, color[1] * ACES_EXPOSURE, color[2] * ACES_EXPOSURE]);
  const fit = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  return times(ACES_OUT, [fit(r), fit(g), fit(b)]);
}

/**
 * The linear colour three's ACES Filmic tone mapping turns into `color`, so
 * unlit theme colours (gridlines, axes, points) come out as the theme's own
 * colour although the whole frame is tone mapped. Colours past the curve's
 * reach come out as near as it gets.
 */
export function beforeAcesFilmic(color: Vec3): [number, number, number] {
  // The curve per channel, v² + 0.0245786v − 0.000090537 = y (0.983729v² + 0.432951v + 0.238081), solved for v ≥ 0.
  const unfit = (target: number) => {
    const y = Math.min(0.999, Math.max(0, target));
    const a = 1 - 0.983729 * y;
    const b = 0.0245786 - 0.432951 * y;
    const c = -(0.000090537 + 0.238081 * y);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  };
  const [r, g, b] = times(ACES_OUT_INVERSE, color);
  const linear = times(ACES_IN_INVERSE, [unfit(r), unfit(g), unfit(b)]);
  return [Math.max(0, linear[0] / ACES_EXPOSURE), Math.max(0, linear[1] / ACES_EXPOSURE), Math.max(0, linear[2] / ACES_EXPOSURE)];
}

/** The union of two extents, either of which may be missing. */
export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
  if (a === null || b === null) return a ?? b;
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export interface SurfaceGrid {
  rows: number;
  cols: number;
  /** x, y, z per vertex; vertex (i, j) at index j * cols + i. */
  positions: Float32Array;
  /** Each vertex's height within the surface's range, 0–1 (for the colour ramp). */
  heights: Float32Array;
}

/**
 * A surface's vertices: `values` holds rows along z (row j at z[0] + j·dz),
 * each across x; ragged rows are cut to the shortest, as in Zeron.
 */
export function surfaceGrid(x: readonly [number, number], z: readonly [number, number], values: readonly (readonly number[])[]): SurfaceGrid {
  const rows = values.length;
  const cols = rows === 0 ? 0 : Math.min(...values.map((row) => row.length));
  const positions = new Float32Array(rows * cols * 3);
  const heights = new Float32Array(rows * cols);
  let low = Infinity;
  let high = -Infinity;
  for (const row of values) {
    for (let i = 0; i < cols; i++) {
      low = Math.min(low, row[i]);
      high = Math.max(high, row[i]);
    }
  }
  const span = Math.max(high - low, 1e-6);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const at = j * cols + i;
      const y = values[j][i];
      positions[at * 3] = x[0] + ((x[1] - x[0]) * i) / Math.max(cols - 1, 1);
      positions[at * 3 + 1] = y;
      positions[at * 3 + 2] = z[0] + ((z[1] - z[0]) * j) / Math.max(rows - 1, 1);
      heights[at] = (y - low) / span;
    }
  }
  return { rows, cols, positions, heights };
}

/** Two triangles per grid cell, for a `rows` × `cols` vertex grid. */
export function gridTriangles(rows: number, cols: number): Uint32Array {
  const indices = new Uint32Array(Math.max(rows - 1, 0) * Math.max(cols - 1, 0) * 6);
  let k = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const a = j * cols + i;
      const b = a + 1;
      const c = a + cols + 1;
      const d = a + cols;
      indices.set([a, d, b, b, d, c], k);
      k += 6;
    }
  }
  return indices;
}

/** The grid's edges along x and along z (no diagonals), as vertex index pairs: a wire surface. */
export function gridEdges(rows: number, cols: number): Uint32Array {
  const edges: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * cols + i;
      if (i < cols - 1) edges.push(a, a + 1);
      if (j < rows - 1) edges.push(a, a + cols);
    }
  }
  return Uint32Array.from(edges);
}

/** `t` (0–1) along a ramp of colours, linearly between neighbours. */
export function rampColor(colors: readonly (readonly [number, number, number])[], t: number): [number, number, number] {
  if (colors.length === 0) return [1, 1, 1];
  const at = Math.min(1, Math.max(0, t)) * (colors.length - 1);
  const index = Math.min(Math.floor(at), colors.length - 2);
  if (index < 0) return [...colors[0]];
  const f = at - index;
  const [a, b] = [colors[index], colors[index + 1]];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Whether two lists of numbers, or lists of lists of numbers, hold the same numbers. */
export function sameNumbers(a: readonly (number | readonly number[])[], b: readonly (number | readonly number[])[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const [x, y] = [a[index], b[index]];
    if (typeof x === "number" || typeof y === "number") {
      if (x !== y) return false;
    } else if (!sameNumbers(x, y)) {
      return false;
    }
  }
  return true;
}
