import type { ReviewRuntimeConfig } from "../../../shared/review-protocol/index.ts";
import { describe, expect, it } from "vitest";

import { reviewStorageKey, reviewWasmUrl } from "./review-client.ts";

const injectedConfig = {
  serverUrl: "http://127.0.0.1:5570",
  reviewId: "desktop-session",
  token: "secret-token",
  wasmUrl: "vscode-file://review/libavoid.wasm",
  appVersion: "0.0.13",
  theme: "dark",
  host: "desktop",
} satisfies ReviewRuntimeConfig;

describe("review host client", () => {
  it("uses injected desktop routing and asset configuration", () => {
    expect(injectedConfig.host).toBe("desktop");
    expect(reviewWasmUrl(injectedConfig)).toBe("vscode-file://review/libavoid.wasm");
    expect(reviewStorageKey(injectedConfig, "files", "main", "head")).toBe(
      "progressive-review:files:desktop-session:main:head",
    );
  });
});
