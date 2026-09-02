import { expect, test } from "bun:test";

import { mountFontPreference } from "../app/font-preference.ts";

class MemoryStyle {
  private readonly values = new Map<string, { value: string; priority: string }>();

  getPropertyPriority(name: string): string {
    return this.values.get(name)?.priority ?? "";
  }

  getPropertyValue(name: string): string {
    return this.values.get(name)?.value ?? "";
  }

  removeProperty(name: string): string {
    const previous = this.getPropertyValue(name);
    this.values.delete(name);
    return previous;
  }

  setProperty(name: string, value: string, priority = ""): void {
    this.values.set(name, { value, priority });
  }
}

test("applies SF Pro to the theme variable and restores the prior value", async () => {
  const controller = new AbortController();
  const style = new MemoryStyle();
  style.setProperty("--bb-monokai-ui-font", "prior-stack", "important");
  const requests: Array<{ input: string; init: RequestInit }> = [];

  const dispose = mountFontPreference(
    {
      pluginId: "monokai",
      generation: 1,
      signal: controller.signal,
    },
    {
      style,
      fetch: async (input, init) => {
        requests.push({ input, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            result: { uiFont: "SF Pro" },
          }),
        };
      },
      sleep: async (_ms, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
    },
  );

  await Bun.sleep(0);
  expect(style.getPropertyValue("--bb-monokai-ui-font")).toBe(
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", sans-serif',
  );
  expect(requests[0]?.input).toBe("/api/v1/plugins/monokai/rpc/getUiFont");
  expect(requests[0]?.init.body).toBe("{}");

  controller.abort();
  dispose();
  expect(style.getPropertyValue("--bb-monokai-ui-font")).toBe("prior-stack");
  expect(style.getPropertyPriority("--bb-monokai-ui-font")).toBe("important");
});

test("replaces an earlier mount so hot reloads keep one active reader", async () => {
  const firstController = new AbortController();
  const secondController = new AbortController();
  const style = new MemoryStyle();
  const requestSignals: AbortSignal[] = [];
  const dependencies = {
    style,
    fetch: async (_input: string, init: RequestInit) => {
      requestSignals.push(init.signal as AbortSignal);
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { uiFont: "Inter (Default)" } }),
      };
    },
    sleep: async (_ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  };

  mountFontPreference(
    { pluginId: "monokai", generation: 1, signal: firstController.signal },
    dependencies,
  );
  await Bun.sleep(0);

  const dispose = mountFontPreference(
    { pluginId: "monokai", generation: 2, signal: secondController.signal },
    dependencies,
  );
  await Bun.sleep(0);

  expect(requestSignals).toHaveLength(2);
  expect(requestSignals[0]?.aborted).toBe(true);
  expect(requestSignals[1]?.aborted).toBe(false);

  dispose();
});
