import { useEffect, useRef, useState } from "react";
import {
  Box3,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

/**
 * A GLB or glTF output, framed in a three-quarter view. Dragging orbits the model; the
 * canvas keeps the wheel. It renders only on change, so idle nodes cost no frames.
 */
export function ModelPreview({ url, name }: { url: string; name: string }) {
  const host = useRef<HTMLElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    setState("loading");
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    element.prepend(renderer.domElement);
    const scene = new Scene();
    scene.add(new HemisphereLight(0xffffff, 0x404048, 2.2));
    const key = new DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 5, 4);
    scene.add(key);
    const camera = new PerspectiveCamera(35, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.enablePan = false;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      render();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    let disposed = false;
    // Tripo ships gltfpack output, which needs the meshopt decoder.
    new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).load(
      url,
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        const bounds = new Box3().setFromObject(model);
        const size = bounds.getSize(new Vector3()).length() || 1;
        model.position.sub(bounds.getCenter(new Vector3()));
        scene.add(model);
        camera.position.set(size * 0.75, size * 0.45, size * 0.95);
        camera.near = size / 100;
        camera.far = size * 100;
        controls.target.set(0, 0, 0);
        controls.update();
        resize();
        setState("ready");
      },
      undefined,
      () => !disposed && setState("error"),
    );
    return () => {
      disposed = true;
      observer.disconnect();
      controls.dispose();
      scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        for (const material of [object.material].flat()) material.dispose();
      });
      renderer.dispose();
      // Browsers cap live WebGL contexts, so release this one now rather than at GC.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [url]);
  return (
    <figure
      ref={host}
      className="gs-model-preview nodrag"
      data-state={state}
      aria-label={`3D preview of ${name}. Drag to orbit.`}
    >
      {state !== "ready" && (
        <span>{state === "loading" ? "Loading model…" : "Could not load the 3D model"}</span>
      )}
    </figure>
  );
}
