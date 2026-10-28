// The three.js side of Scene: one WebGL renderer drawing a list of read
// scene objects (core/scene.ts) the way Zeron's GPU scene does
// (crates/visual-gpu/src/scene.rs): y up, framed on the geometry, a key
// light with soft shadows over an invisible shadow catcher, a fill light, a
// sky-over-ground ambient (or the scene's environment), glass that refracts
// and splits light, bloom from glow, ACES tone mapping, and a transparent
// canvas so the scene sits on the chat. Objects are kept by index and shape
// across updates, so an animated scene moves its meshes instead of
// rebuilding the world each frame.
import {
  ACESFilmicToneMapping,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  CustomBlending,
  CylinderGeometry,
  DataTexture,
  DirectionalLight,
  DoubleSide,
  EquirectangularReflectionMapping,
  FloatType,
  FrontSide,
  Group,
  HalfFloatType,
  LinearSRGBColorSpace,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  OneFactor,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Points,
  PointsMaterial,
  RGBAFormat,
  Scene,
  ShadowMaterial,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Material as ThreeMaterial,
  type Side,
} from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import type { Material, SceneObject, Vec3 } from "../../core/scene";
import { ACCENT } from "../values";
import type { AssetBytes } from "../runtime";
import { COLOR_TOKENS } from "./gpu";
import { decodeEnvironment, decodeModel, decodeTexture } from "./sceneAssets";
import {
  beforeAcesFilmic,
  frameCamera,
  gridEdges,
  gridTriangles,
  rampColor,
  sameNumbers,
  sceneBounds,
  surfaceGrid,
  unionBounds,
  type Bounds,
  type Orbit,
} from "./sceneMath";

export type LabelSize = "xs" | "sm" | "body" | "lg";

export interface SceneWorldOptions {
  canvas: HTMLCanvasElement;
  /** Where labels go, over the canvas; the world owns its children. */
  overlay: HTMLElement;
  /** Classes per label size (kept in the component, where the styles live). */
  labelClass: Readonly<Record<LabelSize, string>>;
  loadAsset: ((src: string) => Promise<AssetBytes>) | null;
  /** Something arrived (a file decoded): draw again. */
  onChange(): void;
  /** Files the scene couldn't use, one user-facing line each. */
  onAssetErrors(errors: readonly string[]): void;
  /** The browser took the context away; `restored` when it gives one back. */
  onContextLost(): void;
  onContextRestored(): void;
}

/** A hover hint under the pointer, in canvas pixels. */
export interface Hint {
  text: string;
  x: number;
  y: number;
}

/** Zeron's key light: from above, to the left and in front, so shadows fall toward the default view. */
const KEY_LIGHT = new Vector3(-0.45, 0.85, 0.35).normalize();
/** Zeron's ambient without an environment: a sky over a ground (linear). */
const SKY: Vec3 = [0.62, 0.66, 0.74];
const GROUND: Vec3 = [0.26, 0.24, 0.22];
/** Zeron's weights: key 3.2, fill 0.9, ambient 0.85. */
const KEY_INTENSITY = 3.2;
const FILL_INTENSITY = 0.9;
const AMBIENT = 0.85;
/**
 * Zeron's bloom is 0.9 × a short blur (half resolution, two 9-tap passes) of
 * the brightness past 1. UnrealBloomPass adds 3 × strength × its mip levels
 * weighted by these factors; mostly the two finest, so a glow stays a halo
 * around the light rather than a haze over the whole scene.
 */
const BLOOM_FACTORS = [1, 0.4, 0.1, 0, 0];
const BLOOM_STRENGTH = 0.9 / 3 / 1.5;
const BLOOM_THRESHOLD = 1;
/** How dark a shadow on the catcher gets over the chat. */
const CATCHER_OPACITY = 0.25;
/** Glass shows mostly what's behind it, tinted a little by its colour (Zeron: 35%). */
const GLASS_TINT = 0.35;
/** Zeron spreads each channel's ior by dispersion × 0.09. */
const DISPERSION_SPREAD = 0.09;
/** How near (px) the pointer must come to a point for its hint. */
const HINT_SLOP = 6;

const DEGREES = Math.PI / 180;

/** OutputPass's tone mapping and encoding (its defines: ACES, sRGB) applied to un-premultiplied colour. */
const STRAIGHT_OUTPUT = /* glsl */ `
precision highp float;
uniform sampler2D tDiffuse;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;
void main() {
  vec4 color = texture2D(tDiffuse, vUv);
  float alpha = clamp(color.a, 0.0, 1.0);
  if (alpha <= 0.0001) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec4 straight = vec4(color.rgb / alpha, 1.0);
  #ifdef ACES_FILMIC_TONE_MAPPING
    straight.rgb = ACESFilmicToneMapping(straight.rgb);
  #endif
  #ifdef SRGB_TRANSFER
    straight = sRGBTransferOETF(straight);
  #endif
  gl_FragColor = vec4(straight.rgb * alpha, alpha);
}`;

/** What an object needs from the world each frame: the projection, for overlays and pixel-sized sprites. */
interface Frame {
  /** World → canvas pixels; null behind the camera. */
  project(at: Vec3): { x: number; y: number } | null;
  /** World units per pixel at unit depth. */
  unitsPerPixel: number;
}

/** One drawn object, kept by index and shape across updates. */
interface Item {
  readonly shape: SceneObject["shape"];
  /** Applies `object` (the item's shape); changes only what changed. */
  update(object: SceneObject): void;
  dispose(): void;
  /** Places what follows the camera (labels, pixel-sized sprites). */
  place?(frame: Frame): void;
  /** The hover hint, when the object has one. */
  hint?(): { at: Vec3; radius: number; text: string } | null;
  /** Extent the static reader can't know (a loaded model's). */
  bounds?(): Bounds | null;
}

type Loaded =
  | { kind: "texture"; texture: Texture }
  | { kind: "model"; scene: Group; box: Box3; glows: boolean }
  | { kind: "environment"; equirect: Texture; target: WebGLRenderTarget };

type AssetKind = Loaded["kind"];

export class SceneWorld {
  private readonly options: SceneWorldOptions;
  private readonly renderer: WebGLRenderer;
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(40, 1, 0.01, 100);
  private readonly key = new DirectionalLight(0xffffff, KEY_INTENSITY);
  private readonly fill = new DirectionalLight(0xffffff, FILL_INTENSITY);
  private readonly catcher = new Mesh(new PlaneGeometry(1, 1), new ShadowMaterial({ opacity: CATCHER_OPACITY }));
  private readonly pmrem: PMREMGenerator;
  private readonly sky: WebGLRenderTarget;
  /** Line widths are in CSS pixels of this size; every LineMaterial shares it. */
  readonly resolution = new Vector2(1, 1);
  private items: Item[] = [];
  private objects: readonly SceneObject[] = [];
  private bounds: Bounds | null = null;
  /** The lowest point of what casts shadows: where the invisible floor catching them lies. */
  private floor: number | null = null;
  private glows = false;
  private width = 1;
  private height = 1;
  /** Reused each frame: the framed centre, and a point being projected. */
  private readonly center = new Vector3();
  private readonly scratch = new Vector3();
  private resolve: (color: string) => readonly [number, number, number] = () => [0.5, 0.5, 0.5];
  private readonly colors = new Map<string, Color>();
  /** Bumped when colours re-resolve, so items that cache derived colours redo them. */
  theme = 0;
  private readonly loaded = new Map<string, Loaded | "loading" | "failed">();
  private readonly assetErrors = new Map<string, string>();
  private readonly geometries = new Map<string, BufferGeometry>();
  private glowTexture: Texture | null = null;
  private discTexture: Texture | null = null;
  private disposed = false;

  constructor(options: SceneWorldOptions) {
    this.options = options;
    const { canvas } = options;
    canvas.addEventListener("webglcontextlost", this.onLost);
    canvas.addEventListener("webglcontextrestored", this.onRestored);
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: "high-performance" });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    // PCF with a radius is three's soft shadow now (PCFSoftShadowMap is gone).
    this.renderer.shadowMap.type = PCFShadowMap;

    // Multisampled half-float targets: HDR for bloom, antialiased edges (the canvas's own AA doesn't reach them).
    this.composer = new EffectComposer(this.renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 }));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Radius 0: the factors below are the weights as given.
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), BLOOM_STRENGTH, 0, BLOOM_THRESHOLD);
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = BLOOM_FACTORS;
    this.composer.addPass(this.bloom);
    const output = new OutputPass();
    // The frame is premultiplied over a clear canvas; tone mapping and sRGB
    // encoding a premultiplied edge pixel brightens it (pale fringes on every
    // silhouette and 1px line), so the colour itself is mapped, as in Zeron's composite.
    output.material.fragmentShader = STRAIGHT_OUTPUT;
    this.composer.addPass(output);

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 4;
    this.key.shadow.bias = -0.0005;
    this.scene.add(this.key, this.key.target, this.fill);
    this.catcher.rotation.x = -Math.PI / 2;
    this.catcher.receiveShadow = true;
    this.scene.add(this.catcher);

    this.pmrem = new PMREMGenerator(this.renderer);
    const sky = skyTexture();
    this.sky = this.pmrem.fromEquirectangular(sky);
    sky.dispose();
    this.useEnvironment(null);
    options.overlay.replaceChildren();
  }

  /** The browser took the context; nothing drawn now is worth keeping. */
  contextLost = false;

  private readonly onLost = (event: Event) => {
    // Lets the browser give the context back; the component rebuilds on restore.
    event.preventDefault();
    this.contextLost = true;
    this.options.onContextLost();
  };

  private readonly onRestored = () => this.options.onContextRestored();

  setSize(width: number, height: number, pixelRatio: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(this.width, this.height);
    this.resolution.set(this.width, this.height);
  }

  /** How theme tokens and #rrggbb become sRGB; call again when the theme flips. */
  setColors(resolve: (color: string) => readonly [number, number, number]): void {
    this.resolve = resolve;
    this.colors.clear();
    this.theme++;
    this.setObjects(this.objects);
  }

  /** A colour in three's linear working space (cached per name until the theme flips). */
  color(name: string): Color {
    let color = this.colors.get(name);
    if (color === undefined) {
      const [r, g, b] = this.resolve(name);
      color = new Color().setRGB(r, g, b, SRGBColorSpace);
      this.colors.set(name, color);
    }
    return color;
  }

  /** A colour for unlit parts (lines, points): the theme's colour on screen once the frame is tone mapped. */
  unlit(name: string): Color {
    const key = `unlit|${name}`;
    let color = this.colors.get(key);
    if (color === undefined) {
      const { r, g, b } = this.color(name);
      color = new Color(...beforeAcesFilmic([r, g, b]));
      this.colors.set(key, color);
    }
    return color;
  }

  /** The CSS colour a DOM overlay uses for a token or #rrggbb (it follows the theme by itself). */
  cssColor(name: string): string {
    return /^#[0-9a-f]{6}$/i.test(name) ? name : (COLOR_TOKENS[name] ?? ACCENT);
  }

  setObjects(objects: readonly SceneObject[]): void {
    if (this.disposed) return;
    this.objects = objects;
    let environment: Extract<SceneObject, { shape: "environment" }> | null = null;
    let glows = false;
    for (const [index, object] of objects.entries()) {
      let item = this.items[index];
      if (item === undefined || item.shape !== object.shape) {
        item?.dispose();
        item = this.createItem(object);
        this.items[index] = item;
      }
      item.update(object);
      if (object.shape === "environment") environment = object;
      if (object.shape === "sprite" || ("material" in object && (object.material.glow ?? 0) > 0)) glows = true;
      if (object.shape === "model" && this.asset("model", object.src)?.glows === true) glows = true;
    }
    for (const item of this.items.splice(objects.length)) item.dispose();
    this.glows = glows;
    this.useEnvironment(environment);
    let bounds = sceneBounds(objects);
    let casters = sceneBounds(objects.filter((object) => "material" in object && !object.material.glass && (object.material.glow ?? 0) === 0));
    for (const item of this.items) {
      const extent = item.bounds?.() ?? null;
      bounds = unionBounds(bounds, extent);
      casters = unionBounds(casters, extent);
    }
    this.bounds = bounds;
    // Lines, points and lights don't reach down to the floor: a beam dipping below a table doesn't sink it.
    this.floor = casters === null ? null : casters.min[1];
    this.catcher.visible = this.floor !== null;
  }

  render(orbit: Orbit): void {
    if (this.disposed) return;
    const view = frameCamera(this.bounds, orbit, this.width, this.height);
    const { camera } = this;
    camera.position.set(...view.eye);
    camera.up.set(0, 1, 0);
    camera.lookAt(...view.target);
    camera.fov = view.fov;
    camera.aspect = this.width / this.height;
    camera.near = view.near;
    camera.far = view.far;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    const center = this.center.set(...view.target);
    const r = view.radius;
    this.key.target.position.copy(center);
    this.key.position.copy(center).addScaledVector(KEY_LIGHT, r * 4);
    const shadow = this.key.shadow.camera;
    shadow.left = -r * 1.3;
    shadow.right = r * 1.3;
    shadow.top = r * 1.3;
    shadow.bottom = -r * 1.3;
    shadow.near = r * 0.5;
    shadow.far = r * 8;
    shadow.updateProjectionMatrix();
    this.key.shadow.normalBias = r * 0.004;
    this.fill.position.set(-KEY_LIGHT.x, 0.35, -KEY_LIGHT.z).normalize().multiplyScalar(r * 4).add(center);
    this.fill.target.position.copy(center);
    this.fill.target.updateMatrixWorld();
    if (this.floor !== null) {
      this.catcher.position.set(center.x, this.floor - r * 0.002, center.z);
      this.catcher.scale.setScalar(r * 8);
    }

    const frame: Frame = {
      project: (at) => {
        const point = this.scratch.set(...at).project(camera);
        if (point.z < -1 || point.z > 1) return null;
        return { x: ((point.x + 1) / 2) * this.width, y: ((1 - point.y) / 2) * this.height };
      },
      unitsPerPixel: (2 * Math.tan((view.fov * DEGREES) / 2)) / this.height,
    };
    for (const item of this.items) item.place?.(frame);
    this.bloom.enabled = this.glows;
    this.composer.render();
  }

  /** The hint of the point nearest (x, y) in canvas pixels, if the pointer is on one. */
  hintAt(x: number, y: number): Hint | null {
    let best: (Hint & { distance: number }) | null = null;
    for (const item of this.items) {
      const hint = item.hint?.();
      if (hint === undefined || hint === null) continue;
      const point = this.scratch.set(...hint.at).project(this.camera);
      if (point.z < -1 || point.z > 1) continue;
      const px = ((point.x + 1) / 2) * this.width;
      const py = ((1 - point.y) / 2) * this.height;
      const distance = Math.hypot(px - x, py - y);
      if (distance <= Math.max(hint.radius, 4) + HINT_SLOP && (best === null || distance < best.distance)) {
        best = { text: hint.text, x: px, y: py, distance };
      }
    }
    return best === null ? null : { text: best.text, x: best.x, y: best.y };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const item of this.items) item.dispose();
    this.items = [];
    for (const geometry of this.geometries.values()) geometry.dispose();
    for (const loaded of this.loaded.values()) if (typeof loaded !== "string") disposeLoaded(loaded);
    this.loaded.clear();
    this.glowTexture?.dispose();
    this.discTexture?.dispose();
    this.catcher.geometry.dispose();
    this.catcher.material.dispose();
    this.sky.dispose();
    this.pmrem.dispose();
    this.bloom.dispose();
    this.composer.dispose();
    const { canvas } = this.options;
    canvas.removeEventListener("webglcontextlost", this.onLost);
    canvas.removeEventListener("webglcontextrestored", this.onRestored);
    this.renderer.dispose();
    // dispose() leaves the context to the garbage collector; the budget in gpu.ts needs it gone now.
    this.renderer.forceContextLoss();
  }

  // ----- Shared resources

  /** A geometry shared by every object that needs it (unit box, spheres and cylinders by detail). */
  shared(key: string, make: () => BufferGeometry): BufferGeometry {
    let geometry = this.geometries.get(key);
    if (geometry === undefined) {
      geometry = make();
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  /** Zeron's sprite glow: a soft round light, brightest at the centre. */
  glow(): Texture {
    this.glowTexture ??= radialTexture((d2) => (Math.exp(-d2 * 5) * 0.7 + Math.exp(-d2 * 48) * 0.8) * (1 - smoothstep(0.7, 1, d2)));
    return this.glowTexture;
  }

  /** A round point, antialiased at its rim. */
  disc(): Texture {
    this.discTexture ??= radialTexture((d2) => 1 - smoothstep(0.82, 1, Math.sqrt(d2)));
    return this.discTexture;
  }

  /** A file the scene names, once loaded; null while it loads or when it failed (the failure is reported). */
  asset<K extends AssetKind>(kind: K, src: string): Extract<Loaded, { kind: K }> | null {
    const key = `${kind}|${src}`;
    const state = this.loaded.get(key);
    if (state !== undefined) return typeof state === "string" ? null : (state as Extract<Loaded, { kind: K }>);
    this.loaded.set(key, "loading");
    void this.load(kind, src).then(
      (loaded) => {
        if (this.disposed) {
          disposeLoaded(loaded);
          return;
        }
        this.loaded.set(key, loaded);
        this.setObjects(this.objects);
        this.options.onChange();
      },
      (cause: unknown) => {
        if (this.disposed) return;
        this.loaded.set(key, "failed");
        this.reportAsset(src, `Couldn't use ${src}: ${cause instanceof Error ? cause.message : String(cause)}`);
      },
    );
    return null;
  }

  reportAsset(src: string, message: string): void {
    this.assetErrors.set(src, message);
    this.options.onAssetErrors([...this.assetErrors.values()]);
  }

  private async load(kind: AssetKind, src: string): Promise<Loaded> {
    const { loadAsset } = this.options;
    if (loadAsset === null) throw new Error("files can't be loaded here");
    const file = await loadAsset(src);
    if (!file.ok) throw new Error(file.error);
    switch (kind) {
      case "texture":
        if (!file.type.startsWith("image/") || file.type === "image/vnd.radiance") throw new Error("a texture must be a png, jpg or webp image");
        return { kind, texture: await decodeTexture(file.bytes, file.type) };
      case "environment": {
        const equirect = await decodeEnvironment(file.bytes, file.type);
        if (this.disposed) {
          disposeTexture(equirect);
          throw new Error("the scene closed");
        }
        return { kind, equirect, target: this.pmrem.fromEquirectangular(equirect) };
      }
      case "model": {
        if (!file.type.startsWith("model/")) throw new Error("a model must be a .glb or .gltf file");
        const { scene, problems } = await decodeModel(file.bytes);
        if (problems.length > 0) this.reportAsset(src, `${src}: ${problems[0]}`);
        scene.updateMatrixWorld(true);
        let glows = false;
        scene.traverse((node) => {
          if (node instanceof Mesh && node.material instanceof MeshStandardMaterial) {
            glows ||= node.material.emissiveIntensity > 0 && node.material.emissive.getHex() !== 0;
          }
        });
        return { kind, scene, box: new Box3().setFromObject(scene), glows };
      }
    }
  }

  private useEnvironment(environment: Extract<SceneObject, { shape: "environment" }> | null): void {
    const loaded = environment === null ? null : this.asset("environment", environment.src);
    if (environment === null || loaded === null) {
      this.scene.environment = this.sky.texture;
      this.scene.environmentIntensity = AMBIENT;
      this.scene.background = null;
      return;
    }
    this.scene.environment = loaded.target.texture;
    this.scene.environmentIntensity = environment.intensity;
    this.scene.background = environment.background ? loaded.equirect : null;
    this.scene.backgroundIntensity = environment.intensity;
  }

  // ----- Items

  private createItem(object: SceneObject): Item {
    switch (object.shape) {
      case "box":
      case "sphere":
      case "cylinder":
        return solidItem(this, this.scene, object.shape);
      case "surface":
        return surfaceItem(this, this.scene);
      case "mesh":
        return meshItem(this, this.scene);
      case "line":
      case "path":
        return lineItem(this, this.scene, object.shape);
      case "point":
        return pointItem(this, this.scene);
      case "label":
        return labelItem(this, this.options.overlay, this.options.labelClass);
      case "grid":
      case "axes":
        return guideItem(this, this.scene, this.options.overlay, this.options.labelClass, object.shape);
      case "model":
        return modelItem(this, this.scene);
      case "sprite":
        return spriteItem(this, this.scene);
      case "environment":
        return { shape: "environment", update() {}, dispose() {} };
    }
  }
}

// ----- Helpers

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** A 64×64 white texture whose alpha is `alpha(d²)`, d the distance from the centre in 0–1. */
function radialTexture(alpha: (d2: number) => number): Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = ((x + 0.5) / size) * 2 - 1;
      const dy = ((y + 0.5) / size) * 2 - 1;
      const at = (y * size + x) * 4;
      image.data.fill(255, at, at + 3);
      image.data[at + 3] = Math.round(Math.min(1, Math.max(0, alpha(dx * dx + dy * dy))) * 255);
    }
  }
  context.putImageData(image, 0, 0);
  return new CanvasTexture(canvas);
}

/** Zeron's ambient without an environment, as an equirectangular map: ground below, sky above. */
function skyTexture(): DataTexture {
  const [width, height] = [64, 32];
  const data = new Float32Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    // Row 0 is the bottom (flipY is off for data textures): straight down.
    const y = -Math.cos(((row + 0.5) / height) * Math.PI);
    const t = smoothstep(-0.3, 0.6, y);
    for (let column = 0; column < width; column++) {
      const at = (row * width + column) * 4;
      for (let channel = 0; channel < 3; channel++) data[at + channel] = GROUND[channel] + (SKY[channel] - GROUND[channel]) * t;
      data[at + 3] = 1;
    }
  }
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.colorSpace = LinearSRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

function disposeLoaded(loaded: Loaded): void {
  switch (loaded.kind) {
    case "texture":
      disposeTexture(loaded.texture);
      break;
    case "environment":
      disposeTexture(loaded.equirect);
      loaded.target.dispose();
      break;
    case "model":
      loaded.scene.traverse((node) => {
        if (!(node instanceof Mesh)) return;
        node.geometry.dispose();
        for (const material of [node.material].flat() as ThreeMaterial[]) disposeMaterial(material);
      });
      break;
  }
}

function disposeTexture(texture: Texture): void {
  texture.dispose();
  if (typeof ImageBitmap !== "undefined" && texture.image instanceof ImageBitmap) texture.image.close();
}

/** A material and the textures it owns (a model's; scene textures are the world's and only released here). */
function disposeMaterial(material: ThreeMaterial): void {
  for (const value of Object.values(material)) if (value instanceof Texture) disposeTexture(value);
  material.dispose();
}

/** Sets a property only when it differs, for those that recompile the shader when set. */
function setIfChanged<T extends object, K extends keyof T>(target: T, key: K, value: T[K], material: ThreeMaterial): void {
  if (target[key] === value) return;
  target[key] = value;
  material.needsUpdate = true;
}

type SolidMaterial = MeshStandardMaterial | MeshPhysicalMaterial;

/**
 * Gives `mesh` the material `m` describes: a physical material with
 * transmission for glass, a standard one otherwise. `thickness` is how deep
 * the glass is (it bends light through that much); `vertexColors` when the
 * geometry carries its colours (a surface's height ramp).
 */
function applyMaterial(
  world: SceneWorld,
  mesh: Mesh<BufferGeometry, SolidMaterial>,
  m: Material,
  options: { thickness: number; side: Side; flat: boolean; vertexColors: boolean },
): void {
  if (m.glass !== mesh.material instanceof MeshPhysicalMaterial) {
    mesh.material.dispose();
    mesh.material = m.glass ? new MeshPhysicalMaterial() : new MeshStandardMaterial();
  }
  const material = mesh.material;
  const color = world.color(m.color);
  if (options.vertexColors) material.color.setRGB(1, 1, 1);
  else if (m.glass) material.color.setRGB(1, 1, 1).lerp(color, GLASS_TINT);
  else material.color.copy(color);
  material.roughness = m.roughness;
  material.metalness = m.glass ? 0 : m.metal;
  material.emissive.copy(color);
  material.emissiveIntensity = m.glow;
  if (material instanceof MeshPhysicalMaterial) {
    material.transmission = 1;
    material.ior = m.ior;
    material.thickness = options.thickness;
    // three spreads each channel's ior by (ior − 1) × 0.025 × dispersion; match Zeron's spread.
    material.dispersion = (m.dispersion * DISPERSION_SPREAD) / Math.max((m.ior - 1) * 0.025, 1e-3);
  }
  setIfChanged(material, "side", options.side, material);
  setIfChanged(material, "flatShading", options.flat, material);
  setIfChanged(material, "vertexColors", options.vertexColors, material);
  const texture = m.texture === null ? null : (world.asset("texture", m.texture)?.texture ?? null);
  setIfChanged(material, "map", texture, material);
  // Lights don't cast shadows (Zeron); nor does glass, which light passes through.
  mesh.castShadow = !m.glass && m.glow === 0;
  mesh.receiveShadow = true;
}

function solidItem(world: SceneWorld, scene: Scene, shape: "box" | "sphere" | "cylinder"): Item {
  const mesh = new Mesh<BufferGeometry, SolidMaterial>(new BufferGeometry(), new MeshStandardMaterial());
  scene.add(mesh);
  return {
    shape,
    update(object) {
      // A zero extent would make a singular matrix; keep it a sliver.
      const sliver = (extent: number) => Math.max(Math.abs(extent), 1e-4);
      let thickness = 1;
      if (object.shape === "box") {
        mesh.geometry = world.shared("box", () => new BoxGeometry(1, 1, 1));
        mesh.scale.set(sliver(object.size[0]), sliver(object.size[1]), sliver(object.size[2]));
        mesh.rotation.set(object.rotate[0] * DEGREES, object.rotate[1] * DEGREES, object.rotate[2] * DEGREES, "ZYX");
        mesh.position.set(...object.at);
        thickness = Math.min(...object.size.map(Math.abs));
      } else if (object.shape === "sphere") {
        const detail = Math.round(object.detail);
        mesh.geometry = world.shared(`sphere:${detail}`, () => new SphereGeometry(1, detail * 2, detail));
        mesh.scale.setScalar(sliver(object.radius));
        mesh.position.set(...object.at);
        thickness = object.radius * 2;
      } else if (object.shape === "cylinder") {
        const detail = Math.round(object.detail);
        // Unit height from its base, so `at` is the base centre and scale.y the height.
        mesh.geometry = world.shared(`cylinder:${detail}`, () => new CylinderGeometry(1, 1, 1, detail).translate(0, 0.5, 0));
        mesh.scale.set(sliver(object.radius), sliver(object.height), sliver(object.radius));
        mesh.position.set(...object.at);
        thickness = object.radius * 2;
      } else {
        return;
      }
      applyMaterial(world, mesh, object.material, { thickness, side: FrontSide, flat: false, vertexColors: false });
    },
    dispose() {
      scene.remove(mesh);
      // The geometry is shared (the world disposes it).
      mesh.material.dispose();
    },
  };
}

function surfaceItem(world: SceneWorld, scene: Scene): Item {
  const group = new Group();
  scene.add(group);
  let mesh: Mesh<BufferGeometry, SolidMaterial> | null = null;
  let wire: LineSegments<BufferGeometry, LineBasicMaterial> | null = null;
  let last: Extract<SceneObject, { shape: "surface" }> | null = null;
  /** What the index buffer depends on: the grid's rows × cols, and wire or faces. */
  let layout = { rows: -1, cols: -1, wire: false };
  let heights: Float32Array = new Float32Array(0);
  let colored = "";
  const clear = () => {
    if (mesh !== null) {
      group.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
      mesh = null;
    }
    if (wire !== null) {
      group.remove(wire);
      wire.geometry.dispose();
      wire.material.dispose();
      wire = null;
    }
  };
  return {
    shape: "surface",
    update(object) {
      if (object.shape !== "surface") return;
      const moved = last === null || !sameNumbers(last.values, object.values) || !sameNumbers(last.x, object.x) || !sameNumbers(last.z, object.z);
      const grid = moved ? surfaceGrid(object.x, object.z, object.values) : null;
      last = object;
      if (grid !== null) {
        heights = grid.heights;
        colored = "";
      }
      const rows = grid?.rows ?? layout.rows;
      const cols = grid?.cols ?? layout.cols;
      if (rows !== layout.rows || cols !== layout.cols || object.wire !== layout.wire) {
        // A new grid shape (or wire ↔ faces): new buffers.
        layout = { rows, cols, wire: object.wire };
        clear();
        const fresh = grid ?? surfaceGrid(object.x, object.z, object.values);
        const built = new BufferGeometry();
        built.setAttribute("position", new BufferAttribute(fresh.positions, 3));
        const uvs = new Float32Array(fresh.rows * fresh.cols * 2);
        for (let j = 0; j < fresh.rows; j++) {
          for (let i = 0; i < fresh.cols; i++) {
            uvs[(j * fresh.cols + i) * 2] = i / Math.max(fresh.cols - 1, 1);
            uvs[(j * fresh.cols + i) * 2 + 1] = j / Math.max(fresh.rows - 1, 1);
          }
        }
        built.setAttribute("uv", new BufferAttribute(uvs, 2));
        built.setAttribute("color", new BufferAttribute(new Float32Array(fresh.rows * fresh.cols * 3), 3));
        heights = fresh.heights;
        colored = "";
        if (object.wire) {
          built.setIndex(new BufferAttribute(gridEdges(fresh.rows, fresh.cols), 1));
          wire = new LineSegments(built, new LineBasicMaterial({ vertexColors: true }));
          group.add(wire);
        } else {
          built.setIndex(new BufferAttribute(gridTriangles(fresh.rows, fresh.cols), 1));
          built.computeVertexNormals();
          mesh = new Mesh<BufferGeometry, SolidMaterial>(built, new MeshStandardMaterial());
          group.add(mesh);
        }
        built.computeBoundingSphere();
      } else if (grid !== null) {
        // Same grid, new heights (an animated surface): rewrite the positions in place.
        const geometry = (mesh?.geometry ?? wire?.geometry)!;
        const position = geometry.getAttribute("position") as BufferAttribute;
        (position.array as Float32Array).set(grid.positions);
        position.needsUpdate = true;
        if (mesh !== null) geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
      }
      const target = mesh?.geometry ?? wire?.geometry;
      if (target === undefined) return;
      // The height ramp, or the material's colour on every vertex (so wire and faces colour alike).
      const colorKey = `${world.theme}|${object.colors?.join(",") ?? object.material.color}`;
      if (colored !== colorKey) {
        colored = colorKey;
        const ramp = (object.colors ?? [object.material.color]).map((name) => {
          const { r, g, b } = world.color(name);
          return [r, g, b] as const;
        });
        const color = target.getAttribute("color") as BufferAttribute;
        const values = color.array as Float32Array;
        // Wire is unlit: its colours are the theme's own after tone mapping, as for lines.
        for (let index = 0; index < heights.length; index++) {
          const shade = rampColor(ramp, heights[index]);
          values.set(object.wire ? beforeAcesFilmic(shade) : shade, index * 3);
        }
        color.needsUpdate = true;
      }
      if (mesh !== null) {
        const radius = target.boundingSphere?.radius ?? 1;
        applyMaterial(world, mesh, object.material, { thickness: radius * 0.2, side: DoubleSide, flat: false, vertexColors: true });
      }
    },
    dispose() {
      clear();
      scene.remove(group);
    },
  };
}

function meshItem(world: SceneWorld, scene: Scene): Item {
  const mesh = new Mesh<BufferGeometry, SolidMaterial>(new BufferGeometry(), new MeshStandardMaterial());
  scene.add(mesh);
  let last: Extract<SceneObject, { shape: "mesh" }> | null = null;
  return {
    shape: "mesh",
    update(object) {
      if (object.shape !== "mesh") return;
      const geometry = mesh.geometry;
      const sameVertices = last !== null && sameNumbers(last.vertices, object.vertices);
      const sameFaces = last !== null && sameNumbers(last.faces, object.faces);
      const sameUvs = last !== null && (last.uvs === object.uvs || (last.uvs !== null && object.uvs !== null && sameNumbers(last.uvs, object.uvs)));
      if (!sameVertices) {
        const current = geometry.getAttribute("position") as BufferAttribute | undefined;
        const positions = Float32Array.from(object.vertices.flat());
        if (current !== undefined && current.count === object.vertices.length) {
          (current.array as Float32Array).set(positions);
          current.needsUpdate = true;
        } else {
          geometry.setAttribute("position", new BufferAttribute(positions, 3));
        }
      }
      if (!sameFaces) geometry.setIndex(new BufferAttribute(Uint32Array.from(object.faces.flat()), 1));
      if (!sameUvs) {
        if (object.uvs !== null && object.uvs.length === object.vertices.length) geometry.setAttribute("uv", new BufferAttribute(Float32Array.from(object.uvs.flat()), 2));
        else geometry.deleteAttribute("uv");
      }
      if (!sameVertices || !sameFaces) {
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
      }
      last = object;
      // Faces as written, whichever way they wind; flat, as Zeron shades them.
      applyMaterial(world, mesh, object.material, { thickness: geometry.boundingSphere?.radius ?? 1, side: DoubleSide, flat: true, vertexColors: false });
    },
    dispose() {
      scene.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}

function lineMaterial(world: SceneWorld): LineMaterial {
  // Alpha to coverage feathers the edges over the multisampled target, so 1px lines stay solid instead of breaking up.
  const material = new LineMaterial({ linewidth: 1, alphaToCoverage: true });
  // Shared, so a resize updates every line at once.
  material.uniforms.resolution.value = world.resolution;
  return material;
}

function lineItem(world: SceneWorld, scene: Scene, shape: "line" | "path"): Item {
  const material = lineMaterial(world);
  let line: Line2 | null = null;
  let points: number[] = [];
  return {
    shape,
    update(object) {
      if (object.shape !== "line" && object.shape !== "path") return;
      const next = object.shape === "line" ? [...object.from, ...object.to] : object.points.flat();
      // A line needs two points; a shorter path draws nothing.
      if (!sameNumbers(points, next)) {
        points = next;
        if (line !== null) {
          scene.remove(line);
          line.geometry.dispose();
          line = null;
        }
        if (next.length >= 6) {
          line = new Line2(new LineGeometry().setPositions(next), material);
          scene.add(line);
        }
      }
      material.color.copy(world.unlit(object.color));
      material.linewidth = object.width;
    },
    dispose() {
      if (line !== null) {
        scene.remove(line);
        line.geometry.dispose();
      }
      material.dispose();
    },
  };
}

function pointItem(world: SceneWorld, scene: Scene): Item {
  const material = new PointsMaterial({ sizeAttenuation: false, map: world.disc(), alphaTest: 0.5 });
  const geometry = world.shared("point", () => new BufferGeometry().setAttribute("position", new BufferAttribute(new Float32Array(3), 3)));
  const points = new Points(geometry, material);
  scene.add(points);
  let hint: { at: Vec3; radius: number; text: string } | null = null;
  return {
    shape: "point",
    update(object) {
      if (object.shape !== "point") return;
      points.position.set(...object.at);
      material.size = object.radius * 2;
      material.color.copy(world.unlit(object.color));
      hint = object.hint === null ? null : { at: object.at, radius: object.radius, text: object.hint };
    },
    hint: () => hint,
    dispose() {
      scene.remove(points);
      material.dispose();
    },
  };
}

/** A DOM label over the canvas, placed each frame. */
function overlayLabel(overlay: HTMLElement): { element: HTMLSpanElement; at: Vec3 | null; place(frame: Frame): void } {
  const element = document.createElement("span");
  overlay.append(element);
  const label = {
    element,
    at: null as Vec3 | null,
    place(frame: Frame) {
      const spot = label.at === null ? null : frame.project(label.at);
      element.style.visibility = spot === null ? "hidden" : "";
      if (spot !== null) element.style.transform = `translate(${spot.x}px, ${spot.y}px) translate(-50%, -50%)`;
    },
  };
  return label;
}

function labelItem(world: SceneWorld, overlay: HTMLElement, classes: Readonly<Record<LabelSize, string>>): Item {
  const label = overlayLabel(overlay);
  return {
    shape: "label",
    update(object) {
      if (object.shape !== "label") return;
      label.at = object.at;
      if (label.element.textContent !== object.text) label.element.textContent = object.text;
      label.element.className = classes[object.size];
      label.element.style.color = world.cssColor(object.color);
    },
    place: (frame) => label.place(frame),
    dispose: () => label.element.remove(),
  };
}

/** The floor grid (border hairlines) and the axes (muted, with xs names), as Zeron draws them. */
function guideItem(world: SceneWorld, scene: Scene, overlay: HTMLElement, classes: Readonly<Record<LabelSize, string>>, shape: "grid" | "axes"): Item {
  const material = lineMaterial(world);
  const lines = new LineSegments2(new LineSegmentsGeometry(), material);
  scene.add(lines);
  const names = shape === "axes" ? [overlayLabel(overlay), overlayLabel(overlay), overlayLabel(overlay)] : [];
  let key = "";
  return {
    shape,
    update(object) {
      if (object.shape === "grid") {
        const next = `${object.size}|${object.step}|${object.y}`;
        if (next !== key) {
          key = next;
          const half = object.size / 2;
          const n = Math.min(200, Math.max(1, Math.round(object.size / object.step)));
          const segments: number[] = [];
          for (let i = 0; i <= n; i++) {
            const t = -half + (object.size * i) / n;
            segments.push(t, object.y, -half, t, object.y, half, -half, object.y, t, half, object.y, t);
          }
          lines.geometry.dispose();
          lines.geometry = new LineSegmentsGeometry().setPositions(segments);
        }
        material.color.copy(world.unlit("border"));
      } else if (object.shape === "axes") {
        const s = object.size;
        if (`${s}` !== key) {
          key = `${s}`;
          lines.geometry.dispose();
          lines.geometry = new LineSegmentsGeometry().setPositions([0, 0, 0, s, 0, 0, 0, 0, 0, 0, s, 0, 0, 0, 0, 0, 0, s]);
        }
        material.color.copy(world.unlit("muted"));
        const texts = object.labels ?? ["x", "y", "z"];
        names.forEach((label, axis) => {
          const end: [number, number, number] = [0, 0, 0];
          end[axis] = s * 1.08;
          label.at = texts[axis] === "" ? null : end;
          label.element.textContent = texts[axis];
          label.element.className = classes.xs;
          label.element.style.color = world.cssColor("muted");
        });
      }
    },
    place(frame) {
      for (const label of names) label.place(frame);
    },
    dispose() {
      scene.remove(lines);
      lines.geometry.dispose();
      material.dispose();
      for (const label of names) label.element.remove();
    },
  };
}

function spriteItem(world: SceneWorld, scene: Scene): Item {
  // A sprite is light (Zeron): its colour adds to what's behind it, and it is
  // as opaque as it is bright, so the dark of a flare image is clear.
  const material = new SpriteMaterial({
    map: world.glow(),
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    depthWrite: false,
    sizeAttenuation: false,
    transparent: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <opaque_fragment>",
      "#include <opaque_fragment>\ngl_FragColor.rgb *= gl_FragColor.a;\ngl_FragColor.a = clamp(max(gl_FragColor.r, max(gl_FragColor.g, gl_FragColor.b)), 0.0, 1.0);",
    );
  };
  const sprite = new Sprite(material);
  sprite.renderOrder = 1;
  scene.add(sprite);
  let size = 48;
  return {
    shape: "sprite",
    update(object) {
      if (object.shape !== "sprite") return;
      sprite.position.set(...object.at);
      size = object.size;
      const map = object.src === null ? world.glow() : (world.asset("texture", object.src)?.texture ?? null);
      setIfChanged(material, "map", map, material);
      sprite.visible = map !== null;
      material.color.copy(world.color(object.color)).multiplyScalar(object.glow);
    },
    place(frame) {
      // Without size attenuation three scales by depth itself; this makes `size` pixels.
      sprite.scale.setScalar(size * frame.unitsPerPixel);
    },
    dispose() {
      scene.remove(sprite);
      material.dispose();
    },
  };
}

function modelItem(world: SceneWorld, scene: Scene): Item {
  const root = new Group();
  scene.add(root);
  let instance: Group | null = null;
  let template: Group | null = null;
  /** The instance's meshes with the model's own material for each (clone(true) shares them). */
  let meshes: { mesh: Mesh; own: ThreeMaterial }[] = [];
  let overrides: SolidMaterial[] = [];
  let overrideKey = "";
  const dropOverrides = () => {
    for (const material of overrides) material.dispose();
    overrides = [];
  };
  return {
    shape: "model",
    update(object) {
      if (object.shape !== "model") return;
      root.position.set(...object.at);
      root.rotation.set(object.rotate[0] * DEGREES, object.rotate[1] * DEGREES, object.rotate[2] * DEGREES, "ZYX");
      const loaded = world.asset("model", object.src);
      if (loaded === null) return;
      if (loaded.scene !== template) {
        if (instance !== null) root.remove(instance);
        dropOverrides();
        template = loaded.scene;
        // Shares the model's geometries and materials (the world owns them).
        instance = loaded.scene.clone(true);
        meshes = [];
        instance.traverse((node) => {
          // glTF primitives are one mesh each, so a material is never a list here.
          if (node instanceof Mesh && !Array.isArray(node.material)) meshes.push({ mesh: node, own: node.material });
        });
        root.add(instance);
        overrideKey = "";
      }
      const box = loaded.box;
      const extent = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z, 1e-6);
      const scale = object.scale * (object.fit === null ? 1 : Math.abs(object.fit) / extent);
      instance!.scale.setScalar(scale);
      // `fit` also centres the model on `at`.
      if (object.fit === null) instance!.position.set(0, 0, 0);
      else instance!.position.copy(box.getCenter(new Vector3())).multiplyScalar(-scale);
      const fields = object.material;
      const texture = typeof fields.texture === "string" ? world.asset("texture", fields.texture) : null;
      const key = `${world.theme}|${texture === null ? "" : texture.texture.uuid}|${JSON.stringify(fields)}`;
      if (key !== overrideKey) {
        overrideKey = key;
        dropOverrides();
        const overridden = Object.keys(fields).length > 0;
        const replaced = new Map<ThreeMaterial, SolidMaterial>();
        for (const { mesh, own } of meshes) {
          mesh.castShadow = !(fields.glass ?? false) && (fields.glow ?? 0) === 0;
          mesh.receiveShadow = true;
          let material = overridden ? replaced.get(own) : undefined;
          if (overridden && material === undefined) {
            material = overrideMaterial(world, own, fields, extent * scale * 0.5);
            replaced.set(own, material);
            overrides.push(material);
          }
          mesh.material = material ?? own;
        }
      }
    },
    bounds() {
      if (instance === null) return null;
      root.updateMatrixWorld(true);
      const box = new Box3().setFromObject(root);
      return box.isEmpty() ? null : { min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] };
    },
    dispose() {
      scene.remove(root);
      dropOverrides();
    },
  };
}

/** A model's material with the fields the scene gave it overriding its own. */
function overrideMaterial(world: SceneWorld, source: ThreeMaterial, fields: Partial<Material>, thickness: number): SolidMaterial {
  const base = source instanceof MeshStandardMaterial ? source : null;
  const glass = fields.glass ?? base instanceof MeshPhysicalMaterial;
  const material: SolidMaterial = glass ? new MeshPhysicalMaterial() : new MeshStandardMaterial();
  if (base !== null) {
    material.color.copy(base.color);
    material.map = base.map;
    material.normalMap = base.normalMap;
    material.roughnessMap = base.roughnessMap;
    material.metalnessMap = base.metalnessMap;
    material.emissiveMap = base.emissiveMap;
    material.emissive.copy(base.emissive);
    material.emissiveIntensity = base.emissiveIntensity;
    material.roughness = base.roughness;
    material.metalness = base.metalness;
    material.side = base.side;
    material.transparent = base.transparent;
    material.opacity = base.opacity;
  }
  if (fields.color !== undefined) {
    const color = world.color(fields.color);
    if (glass) material.color.setRGB(1, 1, 1).lerp(color, GLASS_TINT);
    else material.color.copy(color);
  }
  if (fields.roughness !== undefined) material.roughness = fields.roughness;
  if (fields.metal !== undefined) material.metalness = fields.metal;
  if (fields.glow !== undefined) {
    material.emissive.copy(fields.color === undefined ? material.color : world.color(fields.color));
    material.emissiveIntensity = fields.glow;
  }
  if (fields.texture !== undefined && fields.texture !== null) material.map = world.asset("texture", fields.texture)?.texture ?? null;
  if (material instanceof MeshPhysicalMaterial && glass) {
    const ior = fields.ior ?? 1.5;
    material.transmission = 1;
    material.metalness = 0;
    material.ior = ior;
    material.thickness = thickness;
    material.dispersion = ((fields.dispersion ?? 0) * DISPERSION_SPREAD) / Math.max((ior - 1) * 0.025, 1e-3);
  }
  return material;
}

