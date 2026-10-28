Real 3D, y up, drawn on the GPU with depth, soft shadows from a key light, and bloom; the camera frames your geometry and the reader drags to orbit (wheel or pinch zooms).
Scene(objects, height?: px = 320 (120–720), camera?: {yaw = 0.6, pitch = 0.45, zoom = 1}, orbit?: true, spin?: turntable radians per second = 0, animate?: true when objects is a function).
objects: a list of {shape, ...} records, or a function t => [...] (t in seconds) called every frame for motion; nested lists flatten and null/false drop out, so planets.map(...) and cond ? {...} : null work inside it. Unknown fields are errors.
- {shape: "box", at: [x, y, z], size: n | [w, h, d] = 1, rotate?: [x, y, z] degrees}
- {shape: "sphere", at, radius = 0.5, detail? = 18} · {shape: "cylinder", at (base centre), radius = 0.5, height = 1, detail? = 24}
- {shape: "surface", x: [min, max], z: [min, max], f: (x, z) => y or values: [[y, ...], ...] (rows along z), detail? = 32 (≤ 128), colors?: ["chart1", "chart3"] (a ramp by height), wire?: false}
- {shape: "mesh", vertices: [[x, y, z], ...], faces: [[i, j, k], ...] (0-based; polygons fan), uvs?: [[u, v], ...] per vertex}
- {shape: "line", from, to, color?, width? px} · {shape: "path", points: [[x, y, z], ...], color?, width?}
- {shape: "point", at, radius? px = 3, color?, hint?: "shown on hover"} · {shape: "label", at, text, color?, size?: xs|sm|body|lg}
- {shape: "grid", size? = 10, step? = 1, y? = 0} · {shape: "axes", size? = 1, labels?: ["x", "y", "z"]}
- {shape: "model", src: "chair.glb", at?, rotate?, scale? = 1, fit?: n (centre it, longest side n)}: a glTF (.glb or embedded .gltf) with its own materials and textures; material fields given here override them.
- {shape: "environment", src: "studio.hdr", intensity? = 1, background? = false}: lights the scene from an equirectangular image (HDR best, or PNG/JPG) that metal and glass reflect and glass bends; background: true also draws it behind.
- {shape: "sprite", at, size? = 48 px, color?, glow? = 1, src?: "flare.png"}: a camera-facing light (a soft round glow without src) that blooms.
Materials (box, sphere, cylinder, surface, mesh, model): color, roughness (0 mirror to 1 matte, 0.55), metal (0–1), glow (emits its colour and blooms: lamps, beams, highlights), glass: true (refracts what's behind it; ior = 1.5, dispersion 0–1 splits it into a rainbow, as a prism does), texture: "wood.jpg" (multiplied by color; a mesh needs uvs).
Colours are theme tokens: text, muted, faint, accent, good, warn, bad, info, border, chart1–chart6 (series in order); a material's physical colour may be "#rrggbb" (gold, glass, wood), only in 3D. Solids default to chart1, lines and labels to muted.
Files (models, environments, sprites, textures) are paths like Image's: workspace, $BB_THREAD_STORAGE or /tmp, up to 10 MB; find or make them with your tools first (download; convert KTX2 or EXR to PNG or HDR).
Style: build real forms from several primitives (legs, tops, rims), not single boxes, and give materials so surfaces read as wood, metal or glass. The scene sits on the chat: no backgrounds or floors to paint; a grid is optional. Math: sin cos tan asin acos atan atan2 sqrt clamp lerp range(a, b, step?) random(i) (the same every render) PI TAU. Up to 2,000 objects, 20,000 vertices per mesh, 2,000 path points.
