import { expect, test } from "bun:test";
import { blobQuery } from "../../shared/blob-url.ts";
import type { Comparison } from "../../shared/schema.ts";
import { rangeOf, serveBlob } from "./blob-route.ts";
import { BlobError, type BlobReader } from "./blobs.ts";

const comparison: Comparison = {
  kind: "local",
  hostId: "laptop",
  path: "/Users/me/game",
  base: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  head: "cc36d32a212a2b8b6611fb73549fe6d04fb6ec38",
};

function reader(open: BlobReader["open"]): BlobReader {
  return { open, describe: async () => ({}) as never, text: async () => null };
}

const svg = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>',
);
const url = (path: string) => `http://bb.local/blob?${blobQuery(comparison, "head", path)}`;

test("a file is served as an inert, cacheable download that never runs as a page", async () => {
  const response = await serveBlob(
    reader(async () => ({
      size: svg.length,
      lfs: null,
      range: null,
      body: new Response(svg).body!,
    })),
    new Request(url("Art/icon.svg"), { headers: { "sec-fetch-site": "same-origin" } }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/svg+xml");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(response.headers.get("content-disposition")).toStartWith("attachment");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(response.headers.get("accept-ranges")).toBe("bytes");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(svg);
});

test("a media element's range request gets that part of the file", async () => {
  let asked: unknown = null;
  const response = await serveBlob(
    reader(async (_request, _signal, range) => {
      asked = range;
      return {
        size: 1000,
        lfs: null,
        range: { start: 100, end: 199 },
        body: new Response(new Uint8Array(100)).body!,
      };
    }),
    new Request(url("Audio/hit.ogg"), { headers: { range: "bytes=100-199" } }),
  );
  expect(asked).toEqual({ start: 100, end: 199 });
  expect(response.status).toBe(206);
  expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
  expect(response.headers.get("content-length")).toBe("100");
});

test("only a single byte range is read as one", () => {
  expect(rangeOf("bytes=0-")).toEqual({ start: 0, end: null });
  expect(rangeOf("bytes=-500")).toEqual({ suffix: 500 });
  expect(rangeOf("bytes=0-1,5-9")).toBeNull();
  expect(rangeOf("items=0-1")).toBeNull();
  expect(rangeOf(null)).toBeNull();
});

test("another site cannot embed a preview, and a malformed request reads nothing", async () => {
  let opened = false;
  const files = reader(async () => {
    opened = true;
    throw new Error("read");
  });
  for (const site of ["cross-site", "same-site"]) {
    const response = await serveBlob(
      files,
      new Request(url("a.png"), { headers: { "sec-fetch-site": site } }),
    );
    expect(response.status).toBe(403);
  }
  expect(
    (await serveBlob(files, new Request("http://bb.local/blob?kind=local&side=head"))).status,
  ).toBe(400);
  expect(opened).toBe(false);
});

test("a read that fails says why, and is not cached", async () => {
  const response = await serveBlob(
    reader(async () => {
      throw new BlobError(503, "Local Mac is not connected.");
    }),
    new Request(url("a.png")),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toBe("Local Mac is not connected.");
});
