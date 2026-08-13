import assert from "node:assert/strict";
import test from "node:test";
import { readBbPermissionMode } from "../src/bb-permission.ts";

function responseJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function event(seq: number, permissionMode: unknown): Record<string, unknown> {
  return {
    seq,
    type: "client/turn/requested",
    data: { execution: { permissionMode } },
  };
}

test("reads bb Full as Amp bypass from the thread events", async () => {
  const requestedUrls: URL[] = [];
  const mode = await readBbPermissionMode({
    serverUrl: "http://127.0.0.1:38886",
    threadId: "thread/id",
    fetch: async (input) => {
      requestedUrls.push(new URL(String(input)));
      return responseJson([event(1, "full")]);
    },
  });

  assert.equal(mode, "bypass");
  assert.equal(requestedUrls[0]?.pathname, "/api/v1/threads/thread%2Fid/events");
});

test("uses Amp's normal rules for bb workspace permissions and malformed events", async () => {
  for (const permissionMode of ["accept-edits", "auto", "unexpected"]) {
    const mode = await readBbPermissionMode({
      serverUrl: "http://127.0.0.1:38886",
      threadId: "thread",
      fetch: async () => responseJson([event(1, permissionMode), null]),
    });
    assert.equal(mode, "default");
  }
});

test("uses Amp's normal rules without bb thread context", async () => {
  assert.equal(await readBbPermissionMode({
    serverUrl: "",
    threadId: "",
    fetch: async () => responseJson([]),
  }), "default");
});
