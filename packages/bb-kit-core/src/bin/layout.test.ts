import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRootEntry,
  defaultLayout,
  isLegacySdkPlugin,
  isTypeEdge,
  locate,
  parseLayout,
  typeEdgeSpecifier,
  unitDir,
  unitFile,
} from "./layout.ts";

const kitPkg = {
  bb: { server: "./src/server/server.ts" },
};

test("parseLayout brands a nested src/server composition root", () => {
  const parsed = parseLayout(kitPkg);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.value.sourceRoot, "src");
  assert.equal(parsed.value.compositionRoot, "src/server/server.ts");
  assert.equal(parsed.value.hostEntry, "src/host/host.ts");
  assert.equal(parsed.value.rpcBridge, "src/app/rpc.ts");
  assert.equal(parsed.value.appEntry, "src/app/app.tsx");
});

test("parseLayout refuses a prefix-less kit tree and a flattened src/server.ts", () => {
  const nested = parseLayout({ bb: { server: "./server/server.ts" } });
  assert.equal(nested.ok, false);
  const flat = parseLayout({ bb: { server: "./src/server.ts" } });
  assert.equal(flat.ok, false);
  const legacy = parseLayout({ bb: { server: "./server.ts" } });
  assert.equal(legacy.ok, false);
});

test("isLegacySdkPlugin is true only for a root ./server.ts", () => {
  assert.equal(isLegacySdkPlugin({ bb: { server: "./server.ts" } }), true);
  assert.equal(isLegacySdkPlugin(kitPkg), false);
  assert.equal(isLegacySdkPlugin({ bb: { server: "./server/server.ts" } }), false);
});

test("locate classifies owned, loose-src, displaced, and outside paths", () => {
  const layout = defaultLayout();
  assert.deepEqual(locate(layout, "src/server/rpc/ping.ts"), {
    kind: "owned",
    zone: "server",
    path: "src/server/rpc/ping.ts",
  });
  assert.deepEqual(locate(layout, "src/shared/node/auth.ts"), {
    kind: "owned",
    zone: "shared-node",
    path: "src/shared/node/auth.ts",
  });
  assert.deepEqual(locate(layout, "src/helper.ts"), {
    kind: "loose-src",
    path: "src/helper.ts",
  });
  assert.deepEqual(locate(layout, "server/server.ts"), {
    kind: "displaced",
    zone: "server",
    path: "server/server.ts",
  });
  assert.deepEqual(locate(layout, "test/import.test.ts"), {
    kind: "outside",
    path: "test/import.test.ts",
  });
});

test("unitDir follows dirname(compositionRoot)", () => {
  const layout = defaultLayout();
  assert.equal(unitDir(layout, "rpc"), "src/server/rpc");
  assert.equal(unitFile(layout, "rpc", "read-item"), "src/server/rpc/read-item.ts");
});

test("isTypeEdge is the only app-to-server implementation exemption", () => {
  const layout = defaultLayout();
  assert.equal(isTypeEdge(layout, "src/app/rpc.ts", "src/server/server", true), true);
  assert.equal(isTypeEdge(layout, "src/app/rpc.ts", "src/server/server.ts", false), false);
  assert.equal(isTypeEdge(layout, "src/app/app.tsx", "src/server/server", true), false);
});

test("typeEdgeSpecifier is derived from rpcBridge and compositionRoot", () => {
  assert.equal(typeEdgeSpecifier(defaultLayout()), "../server/server");
});

test("classifyRootEntry flags leftover runtime trees at the plugin root", () => {
  const layout = defaultLayout();
  assert.equal(classifyRootEntry(layout, "src"), "source-prefix");
  assert.equal(classifyRootEntry(layout, "server"), "displaced-runtime");
  assert.equal(classifyRootEntry(layout, "assets"), "other");
});
