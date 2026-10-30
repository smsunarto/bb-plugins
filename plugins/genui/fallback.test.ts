import { describe, expect, it } from "vitest";
import type { DataRequest, LoadedData } from "./core";
import { checkSpec, renderReplyMarkdown } from "./fallback";
import { compile, evaluate, initialState } from "./core";
import { localImages } from "./core/markdown";

const reply = [
  "Pro costs **$290** a month for 10 seats.",
  "",
  "```ui",
  "$seats = 10",
  'Card("Monthly estimate", [Metric("Total", "$" + 29 * $seats)])',
  "```",
  "",
  "```ts",
  "const keep = true;",
  "```",
  "",
  "````app",
  "<title>Bouncing ball</title><canvas></canvas>",
  "````",
  "Done.",
].join("\n");

describe("renderReplyMarkdown", () => {
  it("replaces ui and app fences and leaves prose and other fences alone", async () => {
    const markdown = await renderReplyMarkdown(reply, async () => ({ ok: false, error: "unused" }));
    expect(markdown).toContain("Pro costs **$290** a month for 10 seats.");
    expect(markdown).toContain("**Monthly estimate**");
    expect(markdown).toContain("Total **$290**");
    expect(markdown).not.toContain("```ui");
    expect(markdown).toContain("```ts\nconst keep = true;\n```");
    expect(markdown).toContain("_Interactive app: Bouncing ball. Open this reply in BB to use it._");
    expect(markdown.endsWith("Done.")).toBe(true);
  });

  it("loads the files a spec references", async () => {
    const requested: DataRequest[] = [];
    const spec = ["```ui", 'rows = Load("bench.json")', 'Card("Bench", [Table(["Name"], rows.map(r => [r.name]))])', "```"].join("\n");
    const markdown = await renderReplyMarkdown(spec, async (request): Promise<LoadedData> => {
      requested.push(request);
      return { ok: true, value: [{ name: "parse" }, { name: "render" }] };
    });
    expect(requested).toEqual([{ path: "bench.json", raw: false }]);
    expect(markdown).toContain("| parse |");
    expect(markdown).toContain("| render |");
  });

  it("fetches Snippet files as raw text, apart from parsed loads of the same file", async () => {
    const requested: DataRequest[] = [];
    const spec = ["```ui", 'Card("Config", [Snippet("cfg.json", 2, 2), Text(Load("cfg.json").name)])', "```"].join("\n");
    const markdown = await renderReplyMarkdown(spec, async (request): Promise<LoadedData> => {
      requested.push(request);
      return request.raw ? { ok: true, value: '{\n  "name": "genui"\n}\n' } : { ok: true, value: { name: "genui" } };
    });
    expect(requested).toEqual([
      { path: "cfg.json", raw: true },
      { path: "cfg.json", raw: false },
    ]);
    expect(markdown).toContain('"name": "genui"');
    expect(markdown).not.toContain("error");
  });

  it("returns text without ui or app fences unchanged", async () => {
    const text = "Plain answer.\n\n```js\nx()\n```";
    expect(await renderReplyMarkdown(text, async () => ({ ok: false, error: "" }))).toBe(text);
  });
});

describe("checkSpec", () => {
  const noFiles = async (): Promise<LoadedData> => ({ ok: false, error: "unused" });

  it("reports what breaks once an input is used, though the initial render is clean", async () => {
    const spec = ['$n = 4', '$plan = "Pro"', "prices = {Basic: 12, Pro: 29}", 'Card("Split", [', '  Slider($n, 0, 10), Choice($plan, ["Basic", "Pro", "Team"]),', '  Metric("Each", fmt(100 / $n, 2)), Metric("Total", fmt(prices[$plan] * 10))', "])"].join("\n");
    const { ok, report } = await checkSpec(spec, noFiles);
    expect(ok).toBe(false);
    expect(report).toContain("After setting $n to 0:\n6:26 error: fmt() needs a number, got null");
    expect(report).toContain('After picking "Team" for $plan:\n6:63 error: `*` needs a number, got null');
    expect(report).not.toContain("setting $n to 10");
    expect(report).not.toContain('"Basic"');
  });

  it("reports an error the initial render already has once, not again for every interaction", async () => {
    const { report } = await checkSpec('$on = false\nCard("x", [Toggle($on, "On"), Text(fmt("a"))])', noFiles);
    expect(report.split("Text version")[0].match(/fmt\(\) needs a number/g)).toHaveLength(1);
    expect(report).not.toContain("After ");
  });

  it("passes a block whose inputs all work and says how many it tried", async () => {
    const { ok, report } = await checkSpec('$seats = 10\nCard("x", [Slider($seats, 1, 50), Metric("Total", fmt(29 * $seats))])', noFiles);
    expect(ok).toBe(true);
    expect(report).toMatch(/^No errors\. Tried 2 interactions\./);
  });

  it("reports a broken shader with its pass and line", async () => {
    const spec = 'Card("x", [Shader(`\nvoid mainImage(out vec4 fragColor, in vec2 fragCoord) {\n  fragColor = vec4(nope, 1.0);\n}\n`)])';
    const { ok, report } = await checkSpec(spec, noFiles);
    expect(ok).toBe(false);
    expect(report).toContain("1:12 error: Shader: image, line 3: `nope` is not declared");
    expect(report).toContain("_GPU shader (1 pass). Open this reply in BB to see it._");
  });

  it("reports a scene that breaks once it moves, and asset files it can't read", async () => {
    const spec = 'Scene(t => t > 1 ? [{shape: "box", at: [0, 0, 0], colour: "chart1"}] : [])\nScene([{shape: "model", src: "chair.glb"}, {shape: "environment", src: "big.hdr"}])';
    const requested: DataRequest[] = [];
    const { ok, report } = await checkSpec(spec, async (request): Promise<LoadedData> => {
      requested.push(request);
      // A binary file is "not a text file" to a raw read, yet it exists.
      return request.path === "big.hdr" ? { ok: false, error: "not a text file" } : { ok: false, error: "file not found" };
    });
    expect(ok).toBe(false);
    expect(report).toContain("1:1 error: Scene at t=1.5: object 0 (box): unknown field `colour`. Did you mean `color`?");
    expect(report).toContain("2:1 error: chair.glb: file not found");
    expect(report).not.toContain("big.hdr");
    expect(requested).toEqual([{ path: "chair.glb", raw: true }, { path: "big.hdr", raw: true }]);
  });
});


describe("local image preflight sources", () => {
  it("covers nested image components and evidence using their renderer input shapes", () => {
    const compiled = compile(`$picked = "a"
Card("Evidence", [
  Image("image.png"), Image("image.png"), Image("https://example.com/web.png"),
  Gallery(["gallery.png", {src: "gallery-object.png"}, {query: "forest"}]),
  Compare(["before.png", {path: "after.png"}]),
  Entity("Device", image: "entity.png"), Hotspots("hotspots.png", []),
  OptionCards($picked, [{value: "a", image: "option.png"}]),
  Acceptance([{name: "Visual", status: "passed", evidence: "acceptance.png"}]),
  Provenance([{name: "Build", status: "done", evidence: "provenance.png"}])
])`);
    expect(compiled.diagnostics).toEqual([]);
    if (compiled.program === null) throw new Error("compile failed");
    const evaluated = evaluate(compiled.program, initialState(compiled.program));
    expect(evaluated.diagnostics).toEqual([]);
    expect(localImages(evaluated.roots)).toEqual([
      "image.png", "gallery.png", "gallery-object.png", "before.png", "after.png",
      "entity.png", "hotspots.png", "option.png", "acceptance.png", "provenance.png",
    ]);
  });
});


it("checks a local image revealed by a toggle, deduplicating shared images", async () => {
  const paths: string[] = [];
  const result = await checkSpec(`$more = false
Card("Evidence", [Toggle($more, "More"), Image("good.png"), $more ? Image("/home/codex/scratch/missing.png") : Image("good.png")])`,
    async () => ({ok: false, error: "unused"}), undefined, undefined,
    async (path) => {
      paths.push(path);
      return path === "good.png" ? {ok: true} : {ok: false, error: "outside allowed roots"};
    });
  expect(result.ok).toBe(false);
  expect(result.report).toContain("/home/codex/scratch/missing.png: outside allowed roots");
  expect(paths).toEqual(["good.png", "/home/codex/scratch/missing.png"]);
});


it("checks videos after input changes and posters through the image loader", async () => {
  const videos: string[] = [];
  const images: string[] = [];
  const result = await checkSpec('$clip = "a.mp4"\nCard("Demo", [Choice($clip, ["a.mp4", "missing.mp4"]), Video($clip, poster: "poster.png", caption: "Playback")])',
    async () => ({ ok: false, error: "unused" }), undefined, undefined,
    async (path) => { images.push(path); return { ok: true }; },
    async (path) => { videos.push(path); return path === "missing.mp4" ? { ok: false, error: "file not found" } : { ok: true }; });
  expect(result.ok).toBe(false);
  expect(videos).toEqual(["a.mp4", "missing.mp4"]);
  expect(images).toEqual(["poster.png"]);
  expect(result.report).toContain("missing.mp4: file not found");
  expect(result.report).toContain("Open in BB to play");
});
