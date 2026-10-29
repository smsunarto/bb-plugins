import { describe, expect, it, vi } from "vitest";
const source = vi.hoisted(() => ({ template: "Name: {{name}}\nPlugin id: {{pluginId}}" }));
const read = vi.hoisted(() => vi.fn(() => source.template));
vi.mock("@bb-plugins/instructions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bb-plugins/instructions")>()),
  instructionFiles: () => ({ read }),
}));
import { buildInstalledPluginContext } from "./mention-context";

describe("editable mention prompt", () => {
  it("reads the template only once while bounding oversized rendered metadata", () => {
    read.mockClear();
    source.template = "x".repeat(900) + "Name: {{name}}\nPlugin id: {{pluginId}}";
    const context = buildInstalledPluginContext({ name: "界".repeat(400), pluginId: "p" });
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1024);
    expect(context).toContain('Plugin id: "p"');
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("names the editable file and recovery when its template exceeds the budget", () => {
    read.mockClear();
    source.template = "x".repeat(1025) + "{{name}}{{pluginId}}";
    expect(() => buildInstalledPluginContext({ name: "Example", pluginId: "example" })).toThrow(
      "instructions/installed-plugin.md is too long. Shorten it",
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("preserves the exact plugin id when shortening display metadata", () => {
    source.template = "x".repeat(700) + "Name: {{name}}\nPlugin id: {{pluginId}}";
    const pluginId = "p".repeat(200);
    const context = buildInstalledPluginContext({ name: "n".repeat(300), pluginId });
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(1024);
    expect(context).toContain(`Plugin id: "${pluginId}"`);
  });
  it("identifies the prompt file when an edit introduces an unknown placeholder", () => {
    source.template = "{{unknown}}";
    expect(() => buildInstalledPluginContext({ name: "Example", pluginId: "example" })).toThrow(
      "instructions/installed-plugin.md: Error: no value for {{unknown}}",
    );
  });
});
