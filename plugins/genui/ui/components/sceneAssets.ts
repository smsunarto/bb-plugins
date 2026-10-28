// Turns the bytes a Scene's files arrive as (UiRuntime.loadAsset) into
// three.js objects: glTF models, equirectangular environments and textures.
// Nothing here fetches: the page's CSP may refuse data: and blob: fetches, so
// a model's embedded buffers and images are decoded from memory too.
import {
  EquirectangularReflectionMapping,
  HalfFloatType,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  type Group,
} from "three";
import { GLTFLoader, type GLTFParser } from "three/addons/loaders/GLTFLoader.js";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

/** A data: URI's bytes (base64 or percent-encoded). */
function dataUriBytes(uri: string): Uint8Array<ArrayBuffer> {
  const comma = uri.indexOf(",");
  const body = uri.slice(comma + 1);
  if (/;base64$/i.test(uri.slice(0, comma))) {
    const binary = atob(body);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  return new TextEncoder().encode(decodeURIComponent(body));
}

/** An image file's bytes as a texture, oriented for three's default UVs. */
async function bitmapTexture(bytes: BufferSource, type: string, flipY: boolean): Promise<Texture> {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }), {
    imageOrientation: flipY ? "flipY" : "from-image",
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  });
  // An ImageBitmap ignores the texture's flipY; the bitmap is flipped above instead.
  const texture = new Texture(bitmap);
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

/** A material texture (`texture: "wood.jpg"`): repeating, mipmapped, sRGB. */
export async function decodeTexture(bytes: ArrayBuffer, type: string): Promise<Texture> {
  const texture = await bitmapTexture(bytes, type, true);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 8;
  return texture;
}

/** An environment (`environment {src}`): an equirectangular HDR (linear) or PNG/JPG/WebP (sRGB). */
export async function decodeEnvironment(bytes: ArrayBuffer, type: string): Promise<Texture> {
  const texture =
    type === "image/vnd.radiance"
      ? new HDRLoader().setDataType(HalfFloatType).createDataTexture(bytes)
      : await bitmapTexture(bytes, type, true);
  if (type !== "image/vnd.radiance") texture.colorSpace = SRGBColorSpace;
  texture.mapping = EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Makes a glTF parser read embedded buffers and images from memory. A file
 * reference outside the model fails with a reason: only .glb and .gltf with
 * everything embedded are read.
 */
function inlineResources(problems: string[]) {
  return (parser: GLTFParser) => {
    const loadBuffer = parser.loadBuffer;
    parser.loadBuffer = async (index) => {
      const uri: unknown = parser.json.buffers?.[index]?.uri;
      // The .glb binary chunk is already in memory.
      if (uri === undefined) return loadBuffer.call(parser, index);
      if (typeof uri === "string" && uri.startsWith("data:")) return dataUriBytes(uri).buffer;
      throw new Error(`the model refers to the file ${String(uri)}; use a .glb or embed it`);
    };
    const sources = new Map<number, Promise<Texture>>();
    parser.loadImageSource = (index) => {
      const cached = sources.get(index);
      if (cached !== undefined) return cached.then((texture) => texture.clone());
      const source = parser.json.images?.[index] ?? {};
      const mimeType: string = typeof source.mimeType === "string" ? source.mimeType : "image/png";
      const bytes: Promise<BufferSource> =
        source.bufferView !== undefined
          ? parser.getDependency("bufferView", source.bufferView)
          : typeof source.uri === "string" && source.uri.startsWith("data:")
            ? Promise.resolve(dataUriBytes(source.uri))
            : Promise.reject(new Error(`the model refers to the image ${String(source.uri)}; use a .glb or embed it`));
      const texture = bytes
        // glTF images keep their top-left origin; the loader sets flipY false.
        .then((data) => bitmapTexture(data, mimeType, false))
        .then((loaded) => {
          loaded.userData.mimeType = mimeType;
          return loaded;
        })
        .catch((cause: unknown) => {
          problems.push(cause instanceof Error ? cause.message : String(cause));
          throw cause;
        });
      sources.set(index, texture);
      return texture;
    };
    return { name: "genui_inline_resources" };
  };
}

/** A glTF model (binary or embedded .gltf) and what of it couldn't be read (textures it went without). */
export async function decodeModel(bytes: ArrayBuffer): Promise<{ scene: Group; problems: string[] }> {
  const problems: string[] = [];
  const loader = new GLTFLoader().register(inlineResources(problems));
  const gltf = await loader.parseAsync(bytes, "");
  return { scene: gltf.scene, problems };
}
