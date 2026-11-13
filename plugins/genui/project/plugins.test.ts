import { describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createPluginsSource, type PluginEntry } from "./plugins";

function entry(id: string, overrides: Partial<PluginEntry> = {}): PluginEntry {
  return {
    id,
    name: id,
    version: "0.1.0",
    sourceDisplay: `path · ~/plugins/${id}`,
    sourceNotice: null,
    status: "running",
    statusDetail: null,
    ...overrides,
  };
}

/** An SDK whose plugin list the test settles; `lists` counts the reads. */
function sdk(list: () => Promise<readonly PluginEntry[]>) {
  const world = { lists: 0 };
  const fake = {
    plugins: {
      list: async () => {
        world.lists += 1;
        return { plugins: await list() };
      },
    },
  } as unknown as BbPluginApi["sdk"];
  return { world, source: createPluginsSource(fake) };
}

describe("Plugins source", () => {
  it("answers only the ids asked for, in order, with the fields the component shows", async () => {
    const { source } = sdk(async () => [
      entry("genui", { name: "Generative UI", version: "0.3.2", icon: "Sparkles" }),
      entry("secret-other", { statusDetail: "not asked for" }),
      entry("broken", {
        name: null,
        version: undefined,
        status: "error",
        statusDetail: "server.js threw",
      }),
    ]);
    const answer = await source.plugins(["broken", "nope", "genui"]);
    expect(answer).toMatchObject({
      ok: true,
      plugins: [
        {
          found: true,
          id: "broken",
          name: "broken",
          version: null,
          icon: null,
          status: "error",
          statusDetail: "server.js threw",
        },
        { found: false, id: "nope" },
        {
          found: true,
          id: "genui",
          name: "Generative UI",
          version: "0.3.2",
          icon: "Sparkles",
          source: "path · ~/plugins/genui",
        },
      ],
    });
    expect(JSON.stringify(answer)).not.toContain("secret-other");
  });

  it("shares one list between readers that ask together, and reads again afterwards", async () => {
    let release: (entries: readonly PluginEntry[]) => void = () => {};
    const { world, source } = sdk(() => new Promise((resolve) => (release = resolve)));
    const both = Promise.all([source.plugins(["a"]), source.plugins(["b"])]);
    await Promise.resolve();
    release([entry("a")]);
    expect((await both).map((answer) => answer.ok && answer.plugins[0]?.found)).toEqual([
      true,
      false,
    ]);
    expect(world.lists).toBe(1);
    const again = source.plugins(["a"]);
    await Promise.resolve();
    release([]);
    await again;
    expect(world.lists).toBe(2);
  });

  it("refuses an id that isn't one, and says when BB can't list", async () => {
    const { world, source } = sdk(async () => {
      throw new Error("timeout");
    });
    expect(await source.plugins(["../x"])).toEqual({
      ok: false,
      reason: "invalid",
      message: '"../x" is not a plugin id',
    });
    expect(world.lists).toBe(0);
    expect(await source.plugins(["genui"])).toEqual({
      ok: false,
      reason: "unavailable",
      message: "BB couldn't list its plugins: timeout",
    });
  });
});
