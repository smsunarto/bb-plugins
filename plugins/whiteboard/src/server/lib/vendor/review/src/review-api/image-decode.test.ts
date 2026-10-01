// Vendored from dev.fast review/src/review-api/image-decode.test.ts @4ecc570 (MIT).
import { afterEach, expect, it, vi } from "vitest";

import { decodeImage } from "./image-decode.ts";

afterEach(() => vi.unstubAllGlobals());

it("rejects image ingestion before loading Sharp in Linux Electron", async () => {
  vi.stubGlobal("process", {
    ...process,
    platform: "linux",
    versions: { ...process.versions, electron: "42.10.0" },
  });

  await expect(decodeImage(new Uint8Array())).rejects.toThrow(
    "Image uploads and imports are unavailable in Review Desktop on Linux.",
  );
});
