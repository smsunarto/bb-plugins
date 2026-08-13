import assert from "node:assert/strict";
import test from "node:test";
import { readBbFastMode, readBbPermissionMode } from "../src/bb-execution.ts";

function responseJson(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function event(
  seq: number,
  permissionMode: unknown,
  serviceTier: unknown = "standard",
): Record<string, unknown> {
  return {
    seq,
    type: "client/turn/requested",
    data: { execution: { permissionMode, serviceTier } },
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

test("reads the latest bb Fast selection from the thread events", async () => {
  for (const [events, expected] of [
    [[event(1, "full", "fast")], true],
    [[event(1, "full", "fast"), event(2, "full", "standard")], false],
    [[event(1, "full", "unexpected")], false],
  ] as const) {
    assert.equal(await readBbFastMode({
      serverUrl: "http://127.0.0.1:38886",
      threadId: "thread",
      fetch: async () => responseJson(events),
    }), expected);
  }
});

test("uses standard service without bb thread context", async () => {
  assert.equal(await readBbFastMode({
    serverUrl: "",
    threadId: "",
    fetch: async () => responseJson([]),
  }), false);
});
