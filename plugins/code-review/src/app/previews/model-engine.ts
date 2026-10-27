import type {
  Material,
  Mesh,
  MeshPhongMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  WebGLRenderer,
} from "three";
import type { ModelFormat } from "../../shared/previews.ts";
import type { ComparisonSide } from "../../shared/schema.ts";
import type { ThreeKit } from "./three-kit.ts";

/*
 * Models for the Changes tab, drawn without a WebGL context per card. A
 * browser keeps only a handful of contexts alive, and a review can hold many
 * models, so one offscreen renderer draws every card in turn and each card
 * copies its frame onto a plain 2D canvas. Both sides share one camera, so
 * orbiting one orbits the other, and frames draw only when something moves.
 */

export type ModelStats = {
  meshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  textures: number;
  animations: number;
  /** The bounding box's width, height, and depth, in the model's units. */
  size: [number, number, number];
};

export type LoadedModel = {
  root: Object3D;
  stats: ModelStats;
  /** What could not be read, as of now: a texture may still fail after the model shows. */
  warnings(): string[];
  /** Calls `listener` whenever a file it references finishes loading late. */
  watch(listener: () => void): () => void;
};

/** Where a file the model names lives, at the same side: a texture, a `.bin`, a `.mtl`. */
export type Resolve = (reference: string) => string | null;

export class ModelError extends Error {}

/** The gray a model with no materials of its own is drawn in. */
const UNTEXTURED = 0xb8b8b8;

// ── Loading ──────────────────────────────────────────────────────────────

async function fetchFile(url: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new ModelError((await response.text()) || `The server answered ${response.status}.`);
  }
  return response;
}

function statsOf(kit: ThreeKit, root: Object3D, animations: number): ModelStats {
  let meshes = 0;
  let vertices = 0;
  let triangles = 0;
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((object) => {
    const drawn = object as Partial<Mesh> & { isPoints?: boolean; isLine?: boolean };
    if (!(drawn.isMesh || drawn.isPoints || drawn.isLine) || !drawn.geometry) return;
    meshes++;
    const positions = drawn.geometry.getAttribute("position")?.count ?? 0;
    vertices += positions;
    if (drawn.isMesh) triangles += Math.floor((drawn.geometry.index?.count ?? positions) / 3);
    for (const material of [drawn.material ?? []].flat() as Material[]) {
      materials.add(material);
      for (const value of Object.values(material))
        if (value instanceof kit.Texture) textures.add(value);
    }
  });
  const size = new kit.Box3().setFromObject(root).getSize(new kit.Vector3());
  return {
    meshes,
    vertices,
    triangles,
    materials: materials.size,
    textures: textures.size,
    animations,
    size: [size.x, size.y, size.z].map((value) => (Number.isFinite(value) ? value : 0)) as [
      number,
      number,
      number,
    ],
  };
}

/** One model file and what it references, as a scene graph with its counts. */
export async function loadModel(
  kit: ThreeKit,
  format: ModelFormat,
  url: string,
  resolve: Resolve,
  signal: AbortSignal,
): Promise<LoadedModel> {
  const warnings: string[] = [];
  const missing = new Set<string>();
  const manager = new kit.LoadingManager();
  // A reference that names no file in this comparison loads nothing, rather
  // than reaching whatever server it names.
  manager.setURLModifier((reference) => {
    if (/^(?:data|blob):/i.test(reference)) return reference;
    return resolve(reference) ?? "data:,";
  });
  manager.onError = (reference) => missing.add(reference);
  // Closing the card stops the downloads of what the model references, too.
  signal.addEventListener("abort", () => manager.abort(), { once: true });
  let active = 0;
  let idle: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const itemStart = manager.itemStart.bind(manager);
  const itemEnd = manager.itemEnd.bind(manager);
  manager.itemStart = (reference) => {
    active++;
    itemStart(reference);
  };
  manager.itemEnd = (reference) => {
    itemEnd(reference);
    if (--active === 0) idle?.();
    for (const listener of listeners) listener();
  };
  const response = await fetchFile(url, signal);

  let root: Object3D;
  let animations = 0;
  if (format === "glb" || format === "gltf") {
    const loader = new kit.GLTFLoader(manager).setMeshoptDecoder(kit.MeshoptDecoder);
    try {
      const gltf = await loader.parseAsync(await response.arrayBuffer(), "");
      root = gltf.scene;
      animations = gltf.animations.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/DRACOLoader/.test(message))
        throw new ModelError(
          "This glTF uses Draco mesh compression, which previews cannot decode.",
        );
      if (/KTX2Loader|basisu/i.test(message))
        throw new ModelError("This glTF uses KTX2 textures, which previews cannot decode.");
      throw new ModelError(`The glTF could not be read: ${message}`);
    }
  } else if (format === "fbx") {
    root = new kit.FBXLoader(manager).parse(await response.arrayBuffer(), "");
    animations = root.animations.length;
  } else if (format === "obj") {
    const text = await response.text();
    const obj = new kit.OBJLoader(manager);
    // A URL alone does not load an OBJ's materials: its `.mtl` is read and handed over.
    const library = /^mtllib[ \t]+(.+?)[ \t]*$/m.exec(text)?.[1];
    let described = false;
    if (library) {
      const mtl = resolve(library);
      try {
        if (!mtl) throw new Error("unresolvable");
        const materials = new kit.MTLLoader(manager).parse(
          await (await fetchFile(mtl, signal)).text(),
          "",
        );
        materials.preload();
        obj.setMaterials(materials);
        described = true;
      } catch (error) {
        if (signal.aborted) throw error;
        warnings.push(`Its materials file, ${library}, could not be read, so it shows untextured.`);
      }
    }
    root = obj.parse(text);
    // Without its `.mtl`, every face is white Phong, which the lights wash out to a silhouette.
    if (!described) {
      root.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        const plain = (material: Material) => {
          const { flatShading, vertexColors } = material as MeshPhongMaterial;
          material.dispose();
          return new kit.MeshStandardMaterial({ color: UNTEXTURED, flatShading, vertexColors });
        };
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(plain)
          : plain(mesh.material);
      });
    }
  } else if (format === "dae") {
    const collada = new kit.ColladaLoader(manager).parse(await response.text(), "");
    if (!collada) throw new ModelError("The Collada file could not be read.");
    root = collada.scene;
    animations = collada.scene.animations?.length ?? 0;
  } else if (format === "3mf") {
    root = new kit.ThreeMFLoader(manager).parse(await response.arrayBuffer());
  } else {
    const geometry =
      format === "stl"
        ? new kit.STLLoader().parse(await response.arrayBuffer())
        : new kit.PLYLoader().parse(await response.arrayBuffer());
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    const colored = geometry.hasAttribute("color");
    // A PLY of points has no faces to shade.
    root =
      format === "ply" && !geometry.index
        ? new kit.Points(geometry, new kit.PointsMaterial({ size: 0.01, vertexColors: colored }))
        : new kit.Mesh(
            geometry,
            new kit.MeshStandardMaterial({
              color: colored ? 0xffffff : UNTEXTURED,
              vertexColors: colored,
            }),
          );
  }
  // Textures load after parsing; wait for them, briefly, so the counts and warnings include them.
  if (active > 0) {
    await new Promise<void>((settle) => {
      idle = settle;
      setTimeout(settle, 5000);
    });
  }
  return {
    root,
    stats: statsOf(kit, root, animations),
    warnings: () =>
      missing.size === 0
        ? warnings
        : [
            ...warnings,
            missing.size === 1
              ? "One file it references could not be read, such as a texture."
              : `${missing.size} files it references could not be read, such as textures.`,
          ],
    watch(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Frees a model no stage will draw, such as one that loaded after its card closed. */
export function releaseModel(kit: ThreeKit, model: LoadedModel): void {
  release(kit, model.root);
}

/** A sibling of `path` that a model names, as a repository path. Null outside the repository. */
export function siblingPath(path: string, reference: string): string | null {
  let name = reference.replace(/\\/g, "/");
  if (name === "" || name.endsWith("/")) return null;
  try {
    name = decodeURIComponent(name);
  } catch {
    // Not percent-encoded.
  }
  // An exporter's absolute path (`C:/Users/artist/tex.png`) means nothing here: look beside the model.
  if (/^(?:[a-z]+:)?\//i.test(name)) name = name.split("/").at(-1) ?? "";
  const parts = path.split("/").slice(0, -1);
  for (const part of name.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join("/") : null;
}

// ── Drawing ──────────────────────────────────────────────────────────────

type Shared = { renderer: WebGLRenderer; environment: Texture };
let shared: Shared | null = null;

function sharedRenderer(kit: ThreeKit): Shared {
  if (shared) return shared;
  const canvas = document.createElement("canvas");
  const renderer = new kit.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.toneMapping = kit.NeutralToneMapping;
  renderer.autoClear = false;
  const pmrem = new kit.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new kit.RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  const made = { renderer, environment };
  // A lost context is replaced on the next frame; every scene is uploaded again.
  canvas.addEventListener("webglcontextlost", () => {
    if (shared === made) shared = null;
  });
  shared = made;
  return made;
}

function release(kit: ThreeKit, root: Object3D) {
  const textures = new Set<Texture>();
  root.traverse((object) => {
    const drawn = object as Partial<Mesh>;
    if (!drawn.geometry) return;
    drawn.geometry.dispose();
    for (const material of [drawn.material ?? []].flat() as Material[]) {
      for (const value of Object.values(material))
        if (value instanceof kit.Texture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) texture.dispose();
}

export type Layout = "side" | "stack";

export type Stage = {
  draw(): void;
  setWireframe(on: boolean): void;
  resetView(): void;
  dispose(): void;
};

/**
 * Two models, or one, on `canvas`, orbited together. Each side in `slots`
 * keeps its place, so a side that failed to load leaves its view empty
 * rather than lending it to the other.
 */
export function createStage(
  kit: ThreeKit,
  canvas: HTMLCanvasElement,
  models: { base: LoadedModel | null; head: LoadedModel | null },
  slots: readonly ComparisonSide[],
  layout: () => Layout,
): Stage {
  const context = canvas.getContext("2d");
  if (!context) throw new ModelError("This browser cannot draw models.");
  const camera: PerspectiveCamera = new kit.PerspectiveCamera(40, 1, 0.01, 1000);
  const wireframe = new kit.MeshBasicMaterial({ color: 0xd4d4d4, wireframe: true });
  const scenes = (["base", "head"] as const).flatMap((side) => {
    const model = models[side];
    if (!model) return [];
    const scene: Scene = new kit.Scene();
    scene.add(model.root);
    // PBR materials take light from the room as well as the lamps; Phong and
    // Lambert, as FBX and Collada use, only from the lamps. These levels keep
    // a light surface shaded under either.
    scene.environmentIntensity = 0.5;
    scene.add(new kit.HemisphereLight(0xffffff, 0x444444, 1));
    const sun = new kit.DirectionalLight(0xffffff, 1.5);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    return [{ side, scene }];
  });
  const controls = new kit.OrbitControls(camera, canvas);

  const resetView = () => {
    // Both sides fit one frame, so a model that grew looks bigger.
    const box = new kit.Box3();
    for (const side of ["base", "head"] as const) {
      const root = models[side]?.root;
      if (root) box.union(new kit.Box3().setFromObject(root));
    }
    const sphere = box.isEmpty()
      ? new kit.Sphere(new kit.Vector3(), 1)
      : box.getBoundingSphere(new kit.Sphere());
    const radius = Math.max(sphere.radius, 1e-3);
    const distance = (radius / Math.sin(kit.MathUtils.degToRad(camera.fov / 2))) * 1.15;
    camera.position
      .copy(sphere.center)
      .add(new kit.Vector3(1, 0.6, 1).normalize().multiplyScalar(distance));
    camera.near = distance / 100;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.target.copy(sphere.center);
    controls.update();
  };

  let frame = 0;
  const draw = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const { renderer, environment } = sharedRenderer(kit);
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      renderer.setPixelRatio(1);
      renderer.setSize(width, height, false);
      renderer.setClearColor(0x000000, 0);
      renderer.setScissorTest(false);
      renderer.clear();
      renderer.setScissorTest(true);
      const stacked = layout() === "stack";
      scenes.forEach(({ side, scene }) => {
        scene.environment = environment;
        const index = Math.max(0, slots.indexOf(side));
        const count = Math.max(1, slots.length);
        const w = stacked ? width : Math.floor(width / count);
        const h = stacked ? Math.floor(height / count) : height;
        const x = stacked ? 0 : index * w;
        // GL counts rows from the bottom, so the first side sits on top.
        const y = stacked ? height - (index + 1) * h : 0;
        renderer.setViewport(x, y, w, h);
        renderer.setScissor(x, y, w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.render(scene, camera);
      });
      context.clearRect(0, 0, width, height);
      context.drawImage(renderer.domElement, 0, 0);
    });
  };
  controls.addEventListener("change", draw);
  // A texture that arrives after the first frame shows without waiting for an orbit.
  const unwatch = (["base", "head"] as const).map((side) => models[side]?.watch(draw));
  resetView();

  return {
    draw,
    setWireframe(on) {
      // One unlit color for every edge: a lit wireframe of a flat-shaded model has no normals and draws black.
      for (const { scene } of scenes) scene.overrideMaterial = on ? wireframe : null;
      draw();
    },
    resetView() {
      resetView();
      draw();
    },
    dispose() {
      cancelAnimationFrame(frame);
      controls.removeEventListener("change", draw);
      controls.dispose();
      for (const stop of unwatch) stop?.();
      for (const side of ["base", "head"] as const) {
        const root = models[side]?.root;
        if (root) release(kit, root);
      }
      wireframe.dispose();
    },
  };
}
