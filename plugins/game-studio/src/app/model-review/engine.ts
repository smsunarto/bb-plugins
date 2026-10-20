import * as T from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import {
  animationTime,
  modeAvailability,
  reviewModes,
  type CameraPreset,
  type ModelFacts,
  type ReviewMode,
} from "../../shared/model-review.ts";

type Surface = T.Mesh<T.BufferGeometry, T.Material | T.Material[]>;
type TextureInfo = { id: string; name: string; width: number; height: number };
export type ModelStats = {
  triangles: number;
  vertices: number;
  meshes: number;
  materials: number;
  textures: TextureInfo[];
  joints: string[];
  clips: { name: string; duration: number }[];
  dimensions: number[];
  facts: ModelFacts;
};
export type View = {
  mode: ReviewMode;
  camera?: CameraPreset;
  joint?: number;
  orbit?: {
    position: readonly [number, number, number];
    target: readonly [number, number, number];
  };
  animation?: { clip: string; time: number; speed: number; loop: boolean };
};
const directions: Record<CameraPreset, [number, number, number]> = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, 1, 0.001],
  "three-quarter": [1, 0.55, 1.3],
};
function release(root: T.Object3D) {
  const textures = new Set<T.Texture>();
  root.traverse((object) => {
    if (!(object instanceof T.Mesh || object instanceof T.Line || object instanceof T.Points))
      return;
    object.geometry.dispose();
    for (const material of [object.material].flat()) {
      for (const value of Object.values(material))
        if (value instanceof T.Texture) textures.add(value);
      material.dispose();
    }
  });
  textures.forEach((texture) => {
    texture.dispose();
    const bitmap = texture.image;
    if (typeof ImageBitmap !== "undefined" && bitmap instanceof ImageBitmap) bitmap.close();
  });
}
function cssColor(css: string) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = css;
  context.fillRect(0, 0, 1, 1);
  const pixel = context.getImageData(0, 0, 1, 1).data;
  return new T.Color().setRGB(pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255, T.SRGBColorSpace);
}
/** A labelled 16 × 16 checker over UV 0–1; the labels expose mirrored, rotated or stretched islands. */
function checker() {
  const size = 1024;
  const cells = 16;
  const cell = size / cells;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const context = canvas.getContext("2d")!;
  context.font = `600 ${cell * 0.32}px system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (let row = 0; row < cells; row++)
    for (let column = 0; column < cells; column++) {
      const light = (row + column) % 2 === 0;
      context.fillStyle = light ? "#e8e8e8" : "#484848";
      context.fillRect(column * cell, row * cell, cell, cell);
      context.fillStyle = light ? "#484848" : "#e8e8e8";
      context.fillText(
        `${String.fromCharCode(65 + column)}${row + 1}`,
        (column + 0.5) * cell,
        (row + 0.5) * cell,
      );
    }
  const texture = new T.CanvasTexture(canvas);
  texture.colorSpace = T.SRGBColorSpace;
  texture.wrapS = texture.wrapT = T.RepeatWrapping;
  // glTF UVs put v = 0 at the top of an image.
  texture.flipY = false;
  return texture;
}
/** UV0 edges drawn over the checker in image space (v down), for a corner inset of the frame. */
function uvLayout(meshes: Surface[], checkerTexture: T.Texture, color: T.Color) {
  const scene = new T.Scene();
  const quad = new T.BufferGeometry();
  quad.setAttribute(
    "position",
    new T.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
  );
  quad.setAttribute("uv", new T.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
  quad.setIndex([0, 1, 2, 0, 2, 3]);
  scene.add(new T.Mesh(quad, new T.MeshBasicMaterial({ map: checkerTexture, toneMapped: false })));
  const edges: number[] = [];
  for (const mesh of meshes) {
    const uv = mesh.geometry.getAttribute("uv");
    if (!uv) continue;
    const index = mesh.geometry.index;
    const count = index ? index.count : uv.count;
    const at = (corner: number) => (index ? index.getX(corner) : corner);
    for (let corner = 0; corner + 2 < count; corner += 3) {
      const triangle = [at(corner), at(corner + 1), at(corner + 2)];
      for (let side = 0; side < 3; side++)
        for (const vertex of [triangle[side]!, triangle[(side + 1) % 3]!])
          edges.push(uv.getX(vertex), 1 - uv.getY(vertex), 0.01);
    }
  }
  const lines = new T.BufferGeometry();
  lines.setAttribute("position", new T.Float32BufferAttribute(edges, 3));
  const material = new T.LineBasicMaterial({
    color,
    transparent: true,
    opacity: 0.35,
    toneMapped: false,
  });
  scene.add(new T.LineSegments(lines, material));
  return { scene, camera: new T.OrthographicCamera(0, 1, 1, 0, -1, 1), lines: material };
}
function loadError(cause: unknown) {
  const text = cause instanceof Error ? cause.message : String(cause);
  if (/draco/i.test(text))
    return "This model uses Draco compression, which the viewer cannot decode yet.";
  if (/ktx2|basisu/i.test(text))
    return "This model uses KTX2 textures, which the viewer cannot decode yet.";
  if (/Unexpected token|JSON|magic/i.test(text))
    return "This file is not a valid GLB or glTF model.";
  return `Could not read the model: ${text}`;
}
function weightMaterial(
  original: T.Material,
  mesh: Surface,
  bone: T.Bone | undefined,
  cold: T.Color,
  hot: T.Color,
) {
  const material = new T.MeshBasicMaterial({ side: original.side });
  const localJoint = mesh instanceof T.SkinnedMesh && bone ? mesh.skeleton.bones.indexOf(bone) : -1;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.reviewJoint = { value: localJoint };
    shader.uniforms.reviewCold = { value: cold };
    shader.uniforms.reviewHot = { value: hot };
    shader.vertexShader =
      `uniform float reviewJoint; varying float reviewWeight;\n${shader.vertexShader}`.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>\nreviewWeight = 0.0;\n#ifdef USE_SKINNING\nfor (int i=0; i<4; i++) { if (abs(skinIndex[i] - reviewJoint) < 0.1) reviewWeight += skinWeight[i]; }\n#endif`,
      );
    shader.fragmentShader =
      `uniform vec3 reviewCold; uniform vec3 reviewHot; varying float reviewWeight;\n${shader.fragmentShader}`.replace(
        "#include <color_fragment>",
        "diffuseColor.rgb = mix(reviewCold, reviewHot, clamp(reviewWeight,0.0,1.0));",
      );
  };
  material.customProgramCacheKey = () => `weights-${localJoint}`;
  return material;
}
/** Shows one packed channel as grey; glTF occlusion strength blends towards 1 (unoccluded). */
function isolateChannel(material: T.MeshBasicMaterial, channel: number, strength: number) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.reviewStrength = { value: strength };
    shader.fragmentShader = `uniform float reviewStrength;\n${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      `#ifdef USE_MAP\nvec4 reviewSample = texture2D(map, vMapUv);\ndiffuseColor.rgb *= vec3(1.0 - reviewStrength * (1.0 - reviewSample[${channel}]));\n#endif`,
    );
  };
  material.customProgramCacheKey = () => `channel-${channel}`;
}
function channelMaterial(
  original: T.Material,
  mode: Extract<(typeof reviewModes)[number], { kind: "color" | "scalar" }>,
) {
  // Unlit glTF materials load as MeshBasicMaterial, so read slots by name rather than by class.
  const source = original as T.Material & Partial<T.MeshStandardMaterial>;
  const map = source[mode.map];
  const material = new T.MeshBasicMaterial({
    map: map instanceof T.Texture ? map : null,
    side: original.side,
    transparent: original.transparent,
    opacity: original.opacity,
    alphaTest: original.alphaTest,
    vertexColors: mode.id === "base-color" && original.vertexColors,
  });
  if (mode.kind === "color") {
    const factor = "factor" in mode ? source[mode.factor] : undefined;
    const intensity = mode.id === "emissive" ? (source.emissiveIntensity ?? 1) : 1;
    // Without the slot, show the glTF default: white base color, no emission.
    if (factor instanceof T.Color) material.color.copy(factor).multiplyScalar(intensity);
    else if (mode.id === "emissive") material.color.setScalar(0);
  } else {
    const factor = "factor" in mode ? source[mode.factor] : 1;
    material.color.setScalar(typeof factor === "number" ? factor : 1);
    isolateChannel(
      material,
      mode.channel,
      mode.id === "occlusion" ? (source.aoMapIntensity ?? 1) : 1,
    );
  }
  if (mode.id === "normal-map" || mode.kind === "scalar") {
    const compile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compile.call(material, shader, renderer);
      shader.fragmentShader = shader.fragmentShader.replace("#include <colorspace_fragment>", "");
    };
  }
  material.toneMapped = false;
  return material;
}
export class ReviewEngine {
  readonly renderer: T.WebGLRenderer;
  modelSha256 = "";
  /** Whether the hashed file holds every buffer and image, so its hash pins the whole model. */
  selfContained = false;
  readonly stats: ModelStats = {
    triangles: 0,
    vertices: 0,
    meshes: 0,
    materials: 0,
    textures: [],
    joints: [],
    clips: [],
    dimensions: [],
    facts: { uv: false, normals: false, skin: false, normalMap: false, aoMap: false },
  };
  private scene = new T.Scene();
  private camera = new T.PerspectiveCamera(35, 1, 0.001, 10000);
  private controls: OrbitControls;
  private model = new T.Group();
  private meshes: Surface[] = [];
  private originals = new Map<Surface, T.Material | T.Material[]>();
  private diagnostics: T.Material[] = [];
  private helpers = new T.Group();
  private mixer = new T.AnimationMixer(this.model);
  private clips: T.AnimationClip[] = [];
  private bones: T.Bone[] = [];
  private action: T.AnimationAction | null = null;
  private uv: T.CanvasTexture | null = null;
  private textures = new Map<string, T.Texture>();
  private layout: ReturnType<typeof uvLayout> | null = null;
  private layoutShown = false;
  private environment: T.WebGLRenderTarget;
  private disposed = false;
  private fixedSize = false;
  private radius = 1;
  /** The model's bind-pose bounds after centring. */
  private box = new T.Box3();
  private viewState: View = { mode: "shaded" };
  private wireOverlay = false;
  private background: T.Color;
  private accent: T.Color;
  private cold: T.Color;
  private hot: T.Color;
  private wires: T.MeshBasicMaterial;
  private observer: ResizeObserver;
  private themeObserver: MutationObserver;
  private element: HTMLElement;
  constructor(element: HTMLElement, full = false) {
    this.element = element;
    this.renderer = new T.WebGLRenderer({
      antialias: true,
      alpha: false,
      // Only the full viewer captures; previews skip the per-frame buffer copy.
      preserveDrawingBuffer: full,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = T.SRGBColorSpace;
    this.renderer.toneMapping = T.ACESFilmicToneMapping;
    element.prepend(this.renderer.domElement);
    const style = getComputedStyle(element);
    this.background = cssColor(style.backgroundColor || "#222222");
    const tokenColor = (name: string, fallback: string) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${name}, ${fallback})`;
      element.append(probe);
      const color = cssColor(getComputedStyle(probe).color);
      probe.remove();
      return color;
    };
    this.accent = tokenColor("--ansi-6", "cyan");
    this.cold = tokenColor("--ansi-4", "blue");
    this.hot = tokenColor("--ansi-1", "red");
    this.wires = new T.MeshBasicMaterial({
      color: this.accent,
      wireframe: true,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    });
    this.scene.background = this.background;
    const pmrem = new T.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment.texture;
    this.scene.add(new T.HemisphereLight(0xffffff, 0x404048, 1));
    this.scene.environmentIntensity = 0.8;
    const key = new T.DirectionalLight(0xffffff, 2.5);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    this.scene.add(this.model, this.helpers);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableZoom = full;
    this.controls.enablePan = full;
    this.controls.addEventListener("change", this.render);
    this.themeObserver = new MutationObserver(() => {
      this.background.copy(cssColor(getComputedStyle(element).backgroundColor));
      this.accent.copy(tokenColor("--ansi-6", "cyan"));
      this.wires.color.copy(this.accent);
      this.cold.copy(tokenColor("--ansi-4", "blue"));
      this.hot.copy(tokenColor("--ansi-1", "red"));
      this.layout?.lines.color.copy(this.hot);
      this.render();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    this.observer = new ResizeObserver(() => {
      if (!this.fixedSize) this.resize();
    });
    this.observer.observe(element);
  }
  async load(url: string) {
    const response = await fetch(url).catch(() => {
      throw new Error("Could not reach the model file. Check the connection and retry.");
    });
    if (!response.ok) throw new Error(`Could not download the model (HTTP ${response.status}).`);
    const bytes = await response.arrayBuffer();
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    this.modelSha256 = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const gltf = await new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .parseAsync(bytes, new URL(".", new URL(url, location.href)).href)
      .catch((cause: unknown) => {
        throw new Error(loadError(cause));
      });
    if (this.disposed) {
      release(gltf.scene);
      return;
    }
    this.model.add(gltf.scene);
    this.model.updateMatrixWorld(true);
    const bounds = new T.Box3().setFromObject(this.model);
    if (bounds.isEmpty()) throw new Error("Model contains no renderable geometry");
    this.stats.dimensions = bounds.getSize(new T.Vector3()).toArray();
    this.radius = Math.max(bounds.getSize(new T.Vector3()).length() / 2, 0.001);
    // Center in a parent, preserving animation tracks on the original scene root.
    this.model.position.sub(bounds.getCenter(new T.Vector3()));
    this.box = bounds.clone().translate(this.model.position);
    this.model.updateMatrixWorld(true);
    const materials = new Set<T.Material>();
    const textures = new Set<T.Texture>();
    this.model.traverse((object) => {
      if (!(object instanceof T.Mesh)) return;
      this.meshes.push(object);
      this.originals.set(object, object.material);
      const g = object.geometry;
      this.stats.vertices += g.getAttribute("position")?.count ?? 0;
      this.stats.triangles += (g.index?.count ?? g.getAttribute("position")?.count ?? 0) / 3;
      this.stats.facts.uv ||= !!g.getAttribute("uv");
      this.stats.facts.normals ||= !!g.getAttribute("normal");
      if (object instanceof T.SkinnedMesh && g.getAttribute("skinWeight")) {
        this.stats.facts.skin = true;
        for (const bone of object.skeleton.bones)
          if (!this.bones.includes(bone)) this.bones.push(bone);
      }
      for (const material of [object.material].flat()) {
        materials.add(material);
        if (material instanceof T.MeshStandardMaterial) {
          this.stats.facts.normalMap ||= !!material.normalMap;
          this.stats.facts.aoMap ||= !!material.aoMap;
        }
        for (const value of Object.values(material))
          if (value instanceof T.Texture) textures.add(value);
      }
    });
    if (!this.meshes.length) throw new Error("Model contains no meshes");
    this.stats.meshes = this.meshes.length;
    this.stats.materials = materials.size;
    for (const texture of textures) this.textures.set(texture.uuid, texture);
    this.stats.textures = [...textures].map((texture) => ({
      id: texture.uuid,
      name: texture.name || texture.uuid.slice(0, 8),
      width:
        texture.image && typeof texture.image === "object" && "width" in texture.image
          ? Number(texture.image.width)
          : 0,
      height:
        texture.image && typeof texture.image === "object" && "height" in texture.image
          ? Number(texture.image.height)
          : 0,
    }));
    this.stats.joints = this.bones.map((bone, i) => `${bone.name || "Joint"} [${i}]`);
    const json = gltf.parser.json as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
    this.selfContained = [...(json.buffers ?? []), ...(json.images ?? [])].every(
      (item) => !item.uri || item.uri.startsWith("data:"),
    );
    this.clips = gltf.animations;
    this.stats.clips = this.clips.map((clip, i) => {
      if (!clip.name) clip.name = `Clip ${i + 1}`;
      return { name: clip.name, duration: clip.duration };
    });
    this.camera.near = this.radius / 1000;
    this.camera.far = this.radius * 1000;
    this.camera.updateProjectionMatrix();
    this.resize();
    this.view({ mode: "shaded", camera: "three-quarter" });
    return this.stats;
  }
  private diagnostic(
    original: T.Material,
    mesh: Surface,
    mode: (typeof reviewModes)[number],
    joint: number,
  ): T.Material {
    if (mode.kind === "shaded" || mode.kind === "bounds" || mode.kind === "wireframe") {
      if (mode.kind !== "wireframe") return original;
      if (!mode.overlay)
        return new T.MeshBasicMaterial({
          color: this.accent,
          wireframe: true,
          side: original.side,
        });
      const material = original.clone();
      material.polygonOffset = true;
      material.polygonOffsetFactor = 1;
      material.polygonOffsetUnits = 1;
      return material;
    }
    if (mode.kind === "normals")
      return new T.MeshNormalMaterial({ flatShading: mode.flat, side: original.side });
    if (mode.kind === "skeleton")
      return new T.MeshBasicMaterial({
        color: this.accent,
        transparent: true,
        opacity: 0.13,
        depthWrite: false,
        wireframe: true,
      });
    if (mode.kind === "uv")
      return new T.MeshBasicMaterial({
        map: mesh.geometry.hasAttribute("uv") ? (this.uv ??= checker()) : null,
        color: mesh.geometry.hasAttribute("uv") ? 0xffffff : 0x555555,
        side: original.side,
        toneMapped: false,
      });
    if (mode.kind === "weights")
      return weightMaterial(original, mesh, this.bones[joint], this.cold, this.hot);
    return channelMaterial(original, mode);
  }
  view(next: View) {
    const selected = modeAvailability(this.stats.facts).find((mode) => mode.id === next.mode);
    if (!selected || selected.reason) throw new Error(selected?.reason ?? "Unknown review mode");
    if (
      next.mode === "weights" &&
      (!Number.isInteger(next.joint ?? 0) || (next.joint ?? 0) >= this.bones.length)
    )
      throw new Error("Unknown joint");
    this.viewState = next;
    this.wireOverlay = selected.kind === "wireframe" && selected.overlay;
    this.layoutShown = selected.kind === "uv" && selected.layout;
    this.diagnostics.forEach((material) => material.dispose());
    this.diagnostics = [];
    this.clearHelpers();
    // Helpers are ephemeral and own their geometries/materials.
    for (const mesh of this.meshes) {
      const original = this.originals.get(mesh)!;
      const mapped = [original].flat().map((material) => {
        const diagnostic = this.diagnostic(material, mesh, selected, next.joint ?? 0);
        if (diagnostic !== material) this.diagnostics.push(diagnostic);
        return diagnostic;
      });
      mesh.material = Array.isArray(original) ? mapped : mapped[0]!;
    }
    if (selected.kind === "skeleton") {
      const helper = new T.SkeletonHelper(this.model);
      helper.setColors(this.cold, this.hot);
      [helper.material].flat().forEach((material) => {
        material.depthTest = false;
      });
      helper.renderOrder = 10;
      this.helpers.add(helper);
      for (const bone of this.bones) {
        const marker = new T.Mesh(
          new T.SphereGeometry(this.radius * 0.012, 8, 6),
          new T.MeshBasicMaterial({ color: this.accent, depthTest: false }),
        );
        marker.userData.bone = bone;
        marker.renderOrder = 11;
        this.helpers.add(marker);
      }
    }
    if (selected.kind === "bounds") {
      this.helpers.add(new T.Box3Helper(new T.Box3().setFromObject(this.model), this.accent));
      const grid = new T.GridHelper(this.radius * 3, 10, this.accent, this.accent);
      grid.position.y = -this.stats.dimensions[1]! / 2;
      this.helpers.add(grid);
      this.helpers.add(new T.AxesHelper(this.radius * 1.2));
      this.helpers.add(
        new T.ArrowHelper(new T.Vector3(0, 0, 1), new T.Vector3(), this.radius * 1.5, this.accent),
      );
    }
    if (next.camera) this.preset(next.camera);
    if (next.orbit) this.applyOrbit(next.orbit);
    this.renderAt(0);
  }
  cameraPose() {
    return {
      position: this.camera.position.toArray() as [number, number, number],
      target: this.controls.target.toArray() as [number, number, number],
    };
  }
  private applyOrbit(orbit: NonNullable<View["orbit"]>) {
    this.camera.position.fromArray(orbit.position);
    this.controls.target.fromArray(orbit.target);
    this.controls.update();
  }
  private clearHelpers() {
    this.helpers.traverse((object) => {
      if (object instanceof T.Mesh || object instanceof T.Line) {
        object.geometry.dispose();
        for (const material of [object.material].flat()) material.dispose();
      }
    });
    this.helpers.clear();
  }
  /**
   * Fits the model's bind-pose box from a preset direction. A turntable or an animated view fits
   * its sphere instead, so neither a turn nor a pose that leaves the bind box clips it.
   */
  private preset(preset: CameraPreset, turning = false) {
    const half = T.MathUtils.degToRad(this.camera.fov / 2);
    const tall = Math.tan(half);
    const wide = tall * this.camera.aspect;
    this.controls.target.set(0, 0, 0);
    this.camera.position.fromArray(directions[preset]).normalize();
    this.camera.lookAt(0, 0, 0);
    let distance = (this.radius / Math.sin(half) / Math.min(1, this.camera.aspect)) * 1.05;
    if (!turning && !this.viewState.animation) {
      const toCamera = this.camera.quaternion.clone().invert();
      const { min, max } = this.box;
      distance = 0;
      for (const x of [min.x, max.x])
        for (const y of [min.y, max.y])
          for (const z of [min.z, max.z]) {
            const corner = new T.Vector3(x, y, z).applyQuaternion(toCamera);
            distance = Math.max(
              distance,
              Math.abs(corner.x) / wide + corner.z,
              Math.abs(corner.y) / tall + corner.z,
            );
          }
      distance *= 1.12;
    }
    this.camera.position.multiplyScalar(distance);
    this.controls.update();
  }
  /** Backs the camera out along its view line until no turn about the target can clip the model. */
  private clearTurn() {
    const half = T.MathUtils.degToRad(this.camera.fov / 2);
    // Every vertex lies within this reach of the target, wherever the view was panned.
    const reach = this.radius + this.controls.target.length();
    const safe = (reach / Math.sin(half) / Math.min(1, this.camera.aspect)) * 1.05;
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.length() < safe)
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), safe);
  }
  /** `turn` is a turntable's angle; any number, including 0, frames for a full turn. */
  renderAt(time: number, turn?: number) {
    const animation = this.viewState.animation;
    if (animation) {
      const clip = this.clips.find((item) => item.name === animation.clip);
      if (!clip) throw new Error(`No animation clip ${animation.clip}`);
      if (this.action?.getClip() !== clip) {
        this.mixer.stopAllAction();
        this.action = this.mixer.clipAction(clip);
        this.action.play();
      }
      this.action.enabled = true;
      this.action.paused = false;
      this.action.setLoop(T.LoopOnce, 1);
      this.action.clampWhenFinished = true;
      this.mixer.setTime(
        animationTime(animation.time + time * animation.speed, clip.duration, animation.loop),
      );
    } else if (this.action) {
      this.mixer.stopAllAction();
      this.action = null;
      this.mixer.update(0);
    }
    this.model.updateMatrixWorld(true);
    for (const helper of this.helpers.children)
      if (helper.userData.bone instanceof T.Bone)
        helper.position.copy(helper.userData.bone.getWorldPosition(new T.Vector3()));
    if (turn !== undefined) {
      const preset = this.viewState.camera ?? "three-quarter";
      if (this.viewState.orbit) {
        this.applyOrbit(this.viewState.orbit);
        this.clearTurn();
      } else this.preset(preset, true);
      this.camera.position
        .sub(this.controls.target)
        .applyAxisAngle(new T.Vector3(0, 1, 0), turn)
        .add(this.controls.target);
      this.camera.lookAt(this.controls.target);
    }
    this.render();
  }
  private render = () => {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
    if (this.wireOverlay) {
      const saved = this.meshes.map((mesh) => mesh.material);
      this.meshes.forEach((mesh) => {
        mesh.material = this.wires;
      });
      const background = this.scene.background;
      this.scene.background = null;
      this.renderer.autoClear = false;
      this.renderer.render(this.scene, this.camera);
      this.renderer.autoClear = true;
      this.scene.background = background;
      this.meshes.forEach((mesh, i) => {
        mesh.material = saved[i]!;
      });
    }
    if (this.layoutShown) this.renderLayout();
  };
  private renderLayout() {
    this.layout ??= uvLayout(this.meshes, (this.uv ??= checker()), this.hot);
    const size = this.renderer.getSize(new T.Vector2());
    const short = Math.min(size.x, size.y);
    const side = Math.round(short * 0.42);
    const margin = Math.round(short * 0.025);
    const x = size.x - side - margin;
    const clear = this.renderer.getClearColor(new T.Color());
    this.renderer.setScissorTest(true);
    this.renderer.setScissor(x - 2, margin - 2, side + 4, side + 4);
    this.renderer.setClearColor(this.accent);
    this.renderer.clear();
    this.renderer.setScissor(x, margin, side, side);
    this.renderer.setViewport(x, margin, side, side);
    this.renderer.autoClear = false;
    this.renderer.render(this.layout.scene, this.layout.camera);
    this.renderer.autoClear = true;
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.renderer.setClearColor(clear);
  }
  resize(width?: number, height?: number) {
    this.fixedSize = width !== undefined;
    // A capture owns the camera until it restores the element size.
    this.controls.enabled = !this.fixedSize;
    const rect = this.element.getBoundingClientRect();
    const w = width ?? rect.width;
    const h = height ?? rect.height;
    if (!w || !h || this.disposed) return;
    this.renderer.setPixelRatio(width ? 1 : Math.min(devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (width) this.preset(this.viewState.camera ?? "three-quarter");
    this.render();
  }
  /** Draws a texture's source image stretched over `canvas`; false when it has no drawable image. */
  drawTexture(id: string, canvas: HTMLCanvasElement) {
    const image = this.textures.get(id)?.image as CanvasImageSource | undefined;
    const context = canvas.getContext("2d");
    if (!image || !context) return false;
    try {
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return true;
    } catch {
      return false;
    }
  }
  async png() {
    this.render();
    return new Promise<Blob>((resolve, reject) =>
      this.renderer.domElement.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error("PNG encoding failed"))),
        "image/png",
      ),
    );
  }
  dispose() {
    this.disposed = true;
    this.observer.disconnect();
    this.themeObserver.disconnect();
    this.controls.dispose();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
    for (const mesh of this.meshes) mesh.material = this.originals.get(mesh)!;
    release(this.model);
    this.diagnostics.forEach((material) => material.dispose());
    this.clearHelpers();
    this.uv?.dispose();
    this.layout?.scene.traverse((object) => {
      if (object instanceof T.Mesh || object instanceof T.LineSegments) {
        object.geometry.dispose();
        (object.material as T.Material).dispose();
      }
    });
    this.wires.dispose();
    this.environment.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
