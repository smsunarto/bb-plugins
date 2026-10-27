/*
 * three.js and the loaders the Changes tab previews models and images with,
 * bundled on their own and served from the plugin's `/three-kit.js` route.
 * The app imports it only when a card shows a model or a game image, so a
 * review without one never loads it. Rebuild with `bun run vendor:three`.
 */
export * from "three";
export { OrbitControls } from "three/addons/controls/OrbitControls.js";
export { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
export { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
export { ColladaLoader } from "three/addons/loaders/ColladaLoader.js";
export { EXRLoader } from "three/addons/loaders/EXRLoader.js";
export { FBXLoader } from "three/addons/loaders/FBXLoader.js";
export { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
export { HDRLoader } from "three/addons/loaders/HDRLoader.js";
export { MTLLoader } from "three/addons/loaders/MTLLoader.js";
export { OBJLoader } from "three/addons/loaders/OBJLoader.js";
export { PLYLoader } from "three/addons/loaders/PLYLoader.js";
export { STLLoader } from "three/addons/loaders/STLLoader.js";
export { TGALoader } from "three/addons/loaders/TGALoader.js";
export { ThreeMFLoader } from "three/addons/loaders/3MFLoader.js";
export { TIFFLoader } from "three/addons/loaders/TIFFLoader.js";
