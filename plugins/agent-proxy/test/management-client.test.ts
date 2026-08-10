import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, before, test } from "node:test";
import { ManagementClient, ManagementError } from "../lib/management-client.ts";

interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

let server: Server;
let port: number;
const recorded: Recorded[] = [];
let nextResponse: { status: number; body: string } = { status: 200, body: "{}" };

before(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      recorded.push({
        method: request.method ?? "",
        url: request.url ?? "",
        auth: request.headers.authorization,
        body,
      });
      response.statusCode = nextResponse.status;
      response.setHeader("content-type", "application/json");
      response.end(nextResponse.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "object" && address !== null) port = address.port;
});

after(() => {
  server.close();
});

function client(): ManagementClient {
  return new ManagementClient({ port, key: "test-key", timeoutMs: 2_000 });
}

test("sends the bearer key on every request", async () => {
  nextResponse = { status: 200, body: JSON.stringify([]) };
  await client().authFiles();
  const last = recorded.at(-1)!;
  assert.equal(last.auth, "Bearer test-key");
  assert.equal(last.url, "/v0/management/auth-files");
});

test("authUrl appends is_webui and validates the shape", async () => {
  nextResponse = {
    status: 200,
    body: JSON.stringify({ status: "ok", url: "https://auth.example", state: "anth-1" }),
  };
  const result = await client().authUrl("anthropic");
  assert.deepEqual(result, { url: "https://auth.example", state: "anth-1" });
  assert.equal(recorded.at(-1)!.url, "/v0/management/anthropic-auth-url?is_webui=true");

  nextResponse = { status: 200, body: JSON.stringify({ nope: true }) };
  await assert.rejects(client().authUrl("codex"), /unexpected/);
});

test("authStatus maps wait/ok/error", async () => {
  nextResponse = { status: 200, body: JSON.stringify({ status: "wait" }) };
  assert.deepEqual(await client().authStatus("s"), { status: "pending", detail: null });
  nextResponse = { status: 200, body: JSON.stringify({ status: "ok" }) };
  assert.deepEqual(await client().authStatus("s"), { status: "ok", detail: null });
  nextResponse = { status: 200, body: JSON.stringify({ status: "error", error: "denied" }) };
  assert.deepEqual(await client().authStatus("s"), { status: "error", detail: "denied" });
});

test("auth file status patch and delete shapes", async () => {
  nextResponse = { status: 200, body: "" };
  await client().setAuthFileStatus("a b.json", true);
  let last = recorded.at(-1)!;
  assert.equal(last.method, "PATCH");
  assert.equal(last.url, "/v0/management/auth-files/status");
  assert.deepEqual(JSON.parse(last.body), { name: "a b.json", disabled: true });

  await client().deleteAuthFile("a b.json");
  last = recorded.at(-1)!;
  assert.equal(last.method, "DELETE");
  assert.equal(last.url, "/v0/management/auth-files?name=a%20b.json");

  await client().resetQuota("3");
  last = recorded.at(-1)!;
  assert.deepEqual(JSON.parse(last.body), { auth_index: "3" });
});

test("resources use GET and whole-array PUT", async () => {
  nextResponse = {
    status: 200,
    body: JSON.stringify({ "claude-api-key": [{ "api-key": "k" }] }),
  };
  const value = await client().getResource("claude-api-key");
  assert.deepEqual(value, [{ "api-key": "k" }]);

  nextResponse = { status: 200, body: "" };
  await client().putResource("api-keys", ["a", "b"]);
  const last = recorded.at(-1)!;
  assert.equal(last.method, "PUT");
  assert.equal(last.url, "/v0/management/api-keys");
  assert.deepEqual(JSON.parse(last.body), ["a", "b"]);
});

test("resources reject malformed wrapped responses instead of treating them as empty", async () => {
  nextResponse = { status: 200, body: JSON.stringify({ "claude-api-key": { unexpected: true } }) };
  await assert.rejects(client().getResource("claude-api-key"), /unexpected.*response/);

  // Historical cores returned the array directly; retain compatibility.
  nextResponse = { status: 200, body: JSON.stringify(["legacy-key"]) };
  assert.deepEqual(await client().getResource("api-keys"), ["legacy-key"]);
});

test("unauthorized and 404 map to readable errors", async () => {
  nextResponse = { status: 401, body: "" };
  await assert.rejects(client().authFiles(), (error: unknown) => {
    assert.ok(error instanceof ManagementError);
    assert.equal(error.status, 401);
    assert.match(error.message, /rotate the key/);
    return true;
  });
  nextResponse = { status: 404, body: "" };
  await assert.rejects(client().authFiles(), /management may be disabled/);
});

test("unreachable core maps to a friendly error", async () => {
  const dead = new ManagementClient({ port: 1, key: "k", timeoutMs: 500 });
  await assert.rejects(dead.authFiles(), /not reachable/);
});

test("authFiles unwraps object-wrapped lists", async () => {
  nextResponse = { status: 200, body: JSON.stringify({ files: [{ name: "x.json" }] }) };
  const files = await client().authFiles();
  assert.deepEqual(files, [{ name: "x.json" }]);
});
