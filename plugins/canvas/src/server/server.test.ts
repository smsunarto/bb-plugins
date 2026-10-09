import { expect, it } from "bun:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { PREVIEW_FRAME_HTML } from "../shared/preview-frame.ts";
import plugin from "./server.ts";

it("serves the HTML embed frame page as an opaque sandbox", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "canvas" });
  await plugin(bb);
  try {
    const response = await harness.fetchHttp("GET", "/frame");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
    expect(await response.text()).toBe(PREVIEW_FRAME_HTML);
  } finally {
    await harness.lifecycle.dispose();
  }
});
