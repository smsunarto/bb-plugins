import { expect, test } from "bun:test";
import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";

import plugin from "../src/server/server.ts";
import { CURSOR_COMPLETION_SOUND } from "../src/server/lib/completion-sound.ts";

const mp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0xff]);
const missing = () => Promise.reject(Object.assign(new Error("HTTP 404"), { status: 404 }));

async function load(cursorHosts: Set<string>) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "kitchen-sink",
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_linux", name: "linux-builder", status: "connected" }),
          makeHostResponse({ id: "host_mac", name: "Local Mac", status: "connected" }),
          makeHostResponse({ id: "host_asleep", name: "Build Mac", status: "disconnected" }),
        ],
      },
      files: {
        read: (async ({ hostId, path }: { hostId: string; path: string }) =>
          cursorHosts.has(hostId) && path === CURSOR_COMPLETION_SOUND
            ? {
                path,
                content: Buffer.from(mp3).toString("base64"),
                contentEncoding: "base64",
                mimeType: "audio/mpeg",
                sha256: "x",
                sizeBytes: mp3.byteLength,
              }
            : missing()) as never,
      },
    },
  });
  await plugin(bb);
  const readHosts = () =>
    harness.sdk.callsTo("files.read").map(([args]) => (args as { hostId: string }).hostId);
  return { harness, readHosts };
}

test("serves Cursor's sound from the connected host that has it, then from memory", async () => {
  const { harness, readHosts } = await load(new Set(["host_mac"]));

  const first = await harness.fetchHttp("GET", "/completion-sound");
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("audio/mpeg");
  expect(new Uint8Array(await first.arrayBuffer())).toEqual(mp3);
  expect(readHosts().sort()).toEqual(["host_linux", "host_mac"]);

  const second = await harness.fetchHttp("GET", "/completion-sound");
  expect(new Uint8Array(await second.arrayBuffer())).toEqual(mp3);
  expect(readHosts()).toHaveLength(2);
});

test("answers 404 while no connected host has Cursor, and looks again on the next request", async () => {
  const cursorHosts = new Set<string>();
  const { harness, readHosts } = await load(cursorHosts);

  expect((await harness.fetchHttp("GET", "/completion-sound")).status).toBe(404);

  cursorHosts.add("host_mac");
  const later = await harness.fetchHttp("GET", "/completion-sound");
  expect(later.status).toBe(200);
  expect(readHosts()).toEqual(["host_linux", "host_mac", "host_linux", "host_mac"]);
});
