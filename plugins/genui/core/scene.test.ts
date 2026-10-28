import { describe, expect, it } from "vitest";
import { LIMITS } from "./catalog";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown, type Program } from "./index";
import { readCamera, readScene, sceneAssets, SCENE_LIMITS } from "./scene";
import { isFunctionValue, type FunctionValue, type UiNode, type Value } from "./types";

function program(source: string): Program {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  return result.program;
}

function render(source: string, state?: Record<string, Value>): { roots: UiNode[]; messages: string[] } {
  const compiled = program(source);
  const { roots, diagnostics } = evaluate(compiled, state ?? initialState(compiled));
  return { roots, messages: diagnostics.map((d) => d.message) };
}

function errors(source: string): string[] {
  return compile(source).diagnostics.filter((d) => d.severity === "error").map((d) => d.message);
}

/** The value a one-root `Text(...)` shows. */
function shown(expression: string): string {
  const { roots, messages } = render(`Text(${expression})`);
  expect(messages).toEqual([]);
  return String(roots[0].props.text);
}

function sceneObjects(source: string): Value {
  const { roots, messages } = render(source);
  expect(messages).toEqual([]);
  expect(roots[0].type).toBe("Scene");
  return roots[0].props.objects;
}

/** The function a `KeyValue({f: ...})` holds as its `f`. */
function keyValueFunction(source: string): FunctionValue {
  const pairs = render(source).roots[0].props.pairs;
  const fn = typeof pairs === "object" && pairs !== null && !Array.isArray(pairs) && "f" in pairs ? pairs.f : null;
  if (!isFunctionValue(fn)) throw new Error(`no function in ${source}`);
  return fn;
}

describe("functions as values", () => {
  it("passes an arrow to a function param and calls it per time without re-evaluating the program", () => {
    const objects = sceneObjects('Scene(t => [{shape: "sphere", at: [cos(t), 0, sin(t)], radius: 0.3, color: "chart1", glow: 1}], spin: 0.2)');
    expect(isFunctionValue(objects)).toBe(true);
    const { objects: read, errors } = readScene(objects, 1);
    expect(errors).toEqual([]);
    expect(read).toEqual([
      {
        shape: "sphere",
        at: [Math.cos(1), 0, Math.sin(1)],
        radius: 0.3,
        detail: 18,
        material: { color: "chart1", roughness: 0.55, metal: 0, glow: 1, glass: false, ior: 1.5, dispersion: 0, texture: null },
      },
    ]);
  });

  it("passes a named function by name and closes over state and named values", () => {
    const objects = sceneObjects('$r = 2\nscale = 10\nframe = t => [{shape: "point", at: [$r * t * scale, 0, 0]}]\nScene(frame)');
    expect(readScene(objects, 0.5).objects[0]).toMatchObject({ shape: "point", at: [10, 0, 0] });
  });

  it("allows arrows as object values and list items, still rejects them elsewhere", () => {
    const objects = sceneObjects('Scene([{shape: "surface", f: (x, z) => x + z, detail: 2}])');
    expect(readScene(objects, 0).objects[0]).toMatchObject({ values: [[-2, -1, 0], [-1, 0, 1], [0, 1, 2]] });
    const fn = keyValueFunction("KeyValue({f: x => x * 2})");
    expect(fn.params).toEqual(["x"]);
    expect(fn.call([21])).toEqual({ value: 42, error: null });
    expect(errors("Text(x => 1)")[0]).toContain("arrow functions can only be declared");
    expect(errors("frame = t => t\nText(frame)")[0]).toContain("`frame` is a function; call it");
  });

  it("checks arrow bodies at compile time with their parameters in scope", () => {
    expect(errors('Scene(t => [{shape: "point", at: [tt, 0, 0]}])')[0]).toContain("`tt` is not defined. Did you mean `t`?");
    expect(errors("frame = t => [{f: frame}]\nScene(frame)")[0]).toContain("depends on itself");
  });

  it("gives every call a fresh step budget and reports the overrun instead of throwing", () => {
    // Evaluation reads the scene at t = 0: a scene too slow for one frame becomes an Error node, not a crash.
    const { roots, messages } = render("Scene(t => range(0, 1000).map(i => range(0, 1000).map(j => i + j)))");
    expect(roots[0].type).toBe("Error");
    expect(messages).toEqual([`Scene: objects(t) failed: one call of this function needs more than ${LIMITS.functionSteps} evaluation steps; simplify it`]);
  });

  it("leaves the interpreter usable after a failed call", () => {
    const fn = keyValueFunction("KeyValue({f: n => range(0, n).map(i => range(0, n).map(j => i * j))})");
    expect(fn.call([1000]).error).toContain(`more than ${LIMITS.functionSteps} evaluation steps`);
    expect(fn.call([3])).toEqual({ value: [[0, 0, 0], [0, 1, 2], [0, 2, 4]], error: null });
  });

  it("reserves kind: \"function\" so data can't pose as a function", () => {
    expect(render('KeyValue({kind: "function"})').messages[0]).toContain('`kind: "function"` is reserved');
  });
});

describe("math builtins", () => {
  it("computes trig, clamp, lerp, range and constants", () => {
    expect(shown("fmt(sin(PI / 2) + cos(0) + tan(0), 3)")).toBe("2.000");
    expect(shown("fmt(atan2(1, 1) * 4, 5)")).toBe(shown("fmt(PI, 5)"));
    expect(shown("fmt(asin(1) + acos(1) + atan(0), 4)")).toBe("1.5708");
    expect(shown("fmt(TAU / PI)")).toBe("2");
    expect(shown("clamp(15, 0, 10)")).toBe("10");
    expect(shown("lerp(0, 10, 0.25)")).toBe("2.5");
    expect(shown('range(0, 5).join(",")')).toBe("0,1,2,3,4");
    expect(shown('range(1, 0, -0.25).join(",")')).toBe("1,0.75,0.5,0.25");
    expect(shown('range(5, 0).length')).toBe("0");
  });

  it("caps range and rejects a zero step", () => {
    expect(render("Text(range(0, 2000).length)").messages[0]).toContain(`limited to ${LIMITS.listLength}`);
    expect(render("Text(range(0, 1, 0).length)").messages[0]).toContain("step cannot be 0");
  });

  it("hashes random(i) to the same 0–1 value every time", () => {
    const values = shown('range(0, 200).map(i => random(i)).join(",")').split(",").map(Number);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBe(200);
    expect(shown("random(7)")).toBe(shown("random(7)"));
    expect(shown("random(0)")).toBe(shown("random(-0)"));
    expect(Math.abs(values.reduce((a, b) => a + b, 0) / values.length - 0.5)).toBeLessThan(0.08);
  });

  it("checks arity and protects the constants", () => {
    expect(errors("Text(atan2(1))")[0]).toContain("`atan2` takes 2 arguments");
    expect(errors("PI = 3\nText(PI)")[0]).toContain("`PI` is a built-in constant");
    expect(errors("Text(pi)")[0]).toContain("Did you mean `PI`?");
  });
});

describe("Scene and Shader arguments", () => {
  it("checks literal enums and numbers at compile time", () => {
    expect(errors('Shader("void mainImage(out vec4 c, in vec2 f) {}", blend: "add")')[0]).toContain("blend must be one of light, alpha, opaque");
    expect(errors('Scene([], height: "tall")')[0]).toContain("height needs a number");
    expect(errors("Scene()")[0]).toContain("`Scene` is missing `objects`");
  });

  it("checks computed ones at evaluation", () => {
    expect(render('$b = "add"\nShader("x", blend: $b)').messages[0]).toContain("blend must be one of");
    expect(render('Scene([], camera: {yaw: 1, roll: 2})').messages[0]).toBe("Scene: camera has no field `roll`. It takes yaw, pitch and zoom.");
    expect(render('Shader("x", inputs: {speed: "fast"})').messages[0]).toContain("inputs `speed` must be a number or a boolean");
    expect(render('Shader("x", buffers: ["a", "b", "c", "d", "e"])').messages[0]).toContain("the limit is 4");
  });

  it("turns objects that fail at t = 0 into an Error node naming the object", () => {
    const { roots, messages } = render('Card("x", [Scene([{shape: "sphere", at: [0, 0, 0]}, {shape: "box", at: [0, 0, 0], colour: "chart2"}])])');
    expect(messages).toEqual(["Scene: object 1 (box): unknown field `colour`. Did you mean `color`?"]);
    expect((roots[0].props.children as UiNode[])[0].type).toBe("Error");
  });

  it("falls back to markdown lines", () => {
    expect(toMarkdown(render('Scene([{shape: "sphere", at: [0, 0, 0]}, {shape: "sphere", at: [1, 0, 0]}, {shape: "surface", values: [[0, 1], [1, 0]]}, {shape: "grid"}])').roots)).toBe(
      "_3D scene: 2 spheres, 1 surface. Open this reply in BB to turn it._",
    );
    expect(toMarkdown(render('Shader("a", buffers: ["b"])').roots)).toBe("_GPU shader (2 passes). Open this reply in BB to see it._");
  });
});

describe("readScene", () => {
  const read = (objects: Value, t = 0) => readScene(objects, t);

  it("fills Zeron's defaults and clamps what Zeron clamps", () => {
    const { objects, errors } = read([
      { shape: "box", at: [0, 0, 0], size: 2, roughness: 5, glass: true },
      { shape: "line", from: [0, 0, 0], to: [1, 1, 1], width: 100 },
      { shape: "label", at: [0, 1, 0], text: 42 },
      { shape: "axes" },
      { shape: "sprite", at: [0, 0, 0], color: "#ABC" },
    ]);
    expect(errors).toEqual([]);
    expect(objects[0]).toMatchObject({ size: [2, 2, 2], rotate: [0, 0, 0], material: { roughness: 0.08, glass: true, color: "chart1" } });
    expect(objects[1]).toMatchObject({ color: "muted", width: 12 });
    expect(objects[2]).toMatchObject({ text: "42", size: "xs", color: "muted" });
    expect(objects[3]).toEqual({ shape: "axes", size: 1, labels: null });
    expect(objects[4]).toMatchObject({ size: 48, glow: 1, color: "#aabbcc", src: null });
  });

  it("flattens nested lists and drops null and false", () => {
    expect(read([[{ shape: "grid" }, null], false, [[{ shape: "axes" }]]]).objects.map((o) => o.shape)).toEqual(["grid", "axes"]);
  });

  it("names the object and field of each error", () => {
    const { objects, errors } = read([
      { shape: "sphere" },
      { shape: "sphre", at: [0, 0, 0] },
      { shape: "box", at: [0, 0] },
      { shape: "point", at: [0, 0, 0], color: "red" },
      { shape: "path", points: [[0, 0, 0]] },
      { shape: "mesh", vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces: [[0, 1, 3]] },
      { shape: "surface", f: null, values: null },
      "box",
    ]);
    expect(objects).toEqual([]);
    expect(errors).toEqual([
      "object 0 (sphere): needs `at`, as in at: [0, 1, 0]",
      expect.stringContaining("object 1: `shape` must be one of box, sphere,"),
      "object 2 (box): `at` must be [x, y, z] numbers, got a list",
      expect.stringContaining('object 3 (point): `color` must be a theme colour (accent, text, muted'),
      "object 4 (path): `points` needs at least 2 points",
      "object 5 (mesh): `faces`[0] must be 3 or more vertex indexes from 0 to 2, got a list",
      "object 6 (surface): needs either `f: (x, z) => height` or `values: [[...], ...]` (rows along z)",
      'object 7: must be an object such as {shape: "sphere", at: [0, 1, 0]}, got "box"',
    ]);
    expect(errors[1]).toContain("Did you mean `sphere`?");
  });

  it("lists a shape's fields when an unknown one has no close match", () => {
    expect(read([{ shape: "grid", wobble: 1 }]).errors).toEqual(["object 0 (grid): unknown field `wobble`. grid takes size, step, y."]);
  });

  it("fans mesh polygons into triangles and checks uvs", () => {
    const quad = { shape: "mesh", vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], faces: [[0, 1, 2, 3]] };
    expect(read([quad]).objects[0]).toMatchObject({ faces: [[0, 1, 2], [0, 2, 3]], uvs: null });
    expect(read([{ ...quad, uvs: [[0, 0]] }]).errors[0]).toBe("object 0 (mesh): `uvs` must be one [u, v] per vertex (4)");
  });

  it("samples a surface's f on a (detail + 1)² grid and reports a failing call", () => {
    const fn = (body: (x: number, z: number) => Value): FunctionValue => ({
      kind: "function",
      params: ["x", "z"],
      call: ([x, z]) => ({ value: body(x as number, z as number), error: null }),
    });
    const surface = read([{ shape: "surface", x: [0, 2], z: [0, 1], detail: 2, f: fn((x, z) => x * 10 + z) }]).objects[0];
    expect(surface).toMatchObject({ values: [[0, 10, 20], [0.5, 10.5, 20.5], [1, 11, 21]], colors: null, wire: false });
    expect(read([{ shape: "surface", detail: 2, f: fn(() => null) }]).errors).toEqual(["object 0 (surface): f(-1, -1) must return a number, got null"]);
    const failing: FunctionValue = { kind: "function", params: [], call: () => ({ value: null, error: "boom" }) };
    expect(read([{ shape: "surface", f: failing }]).errors).toEqual(["object 0 (surface): f(-1, -1) failed: boom"]);
    expect(read(failing).errors).toEqual(["objects(t) failed: boom"]);
  });

  it("enforces the limits at their boundaries", () => {
    const point = { shape: "point", at: [0, 0, 0] };
    expect(read(Array.from({ length: SCENE_LIMITS.objects }, () => point)).errors).toEqual([]);
    expect(read(Array.from({ length: SCENE_LIMITS.objects + 1 }, () => point)).errors).toEqual(["the scene has 2001 objects; the limit is 2000"]);
    const surface = (detail: number) => ({ shape: "surface", values: [[0, 0], [0, 0]], detail });
    expect(read([surface(SCENE_LIMITS.surfaceDetail)]).errors).toEqual([]);
    expect(read([surface(SCENE_LIMITS.surfaceDetail + 1)]).errors).toEqual(["object 0 (surface): `detail` is 129; the limit is 128"]);
    const path = (n: number) => ({ shape: "path", points: Array.from({ length: n }, (_, i) => [i, 0, 0]) });
    expect(read([path(SCENE_LIMITS.pathPoints)]).errors).toEqual([]);
    expect(read([path(SCENE_LIMITS.pathPoints + 1)]).errors[0]).toContain("the limit is 2000");
    const mesh = (n: number) => ({ shape: "mesh", vertices: Array.from({ length: n }, () => [0, 0, 0]), faces: [[0, 1, 2]] });
    expect(read([mesh(SCENE_LIMITS.meshVertices)]).errors).toEqual([]);
    expect(read([mesh(SCENE_LIMITS.meshVertices + 1)]).errors[0]).toContain("the limit is 20000");
  });

  it("keeps only the material fields a model sets, and collects asset paths once", () => {
    const { objects } = read([
      { shape: "model", src: "a.glb", glass: true, color: "#ff0000" },
      { shape: "environment", src: "studio.hdr" },
      { shape: "box", at: [0, 0, 0], texture: "wood.jpg" },
      { shape: "sprite", at: [0, 0, 0], src: "flare.png" },
      { shape: "model", src: "a.glb" },
    ]);
    expect(objects[0]).toMatchObject({ at: [0, 0, 0], scale: 1, fit: null, material: { glass: true, color: "#ff0000", roughness: 0.08 } });
    const last = objects[4];
    expect(last.shape === "model" && last.material).toEqual({});
    expect(sceneAssets(objects)).toEqual(["a.glb", "studio.hdr", "wood.jpg", "flare.png"]);
  });

  it("reads a camera with its defaults", () => {
    expect(readCamera(undefined)).toEqual({ camera: { yaw: 0.6, pitch: 0.45, zoom: 1 }, error: null });
    expect(readCamera({ zoom: 2 }).camera).toEqual({ yaw: 0.6, pitch: 0.45, zoom: 2 });
    expect(readCamera({ zoom: "near" }).error).toBe('camera `zoom` must be a number, got "near"');
  });
});
