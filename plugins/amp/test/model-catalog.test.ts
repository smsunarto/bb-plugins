import assert from "node:assert/strict";
import { test } from "bun:test";
import { BRIDGE_REQUEST_METHODS } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_captureBridgeJsonRpcOutput as captureBridgeJsonRpcOutput } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "../src/bridge/entry.ts";
import { AMP_FALLBACK_MODELS, AMP_WIRE_MODELS } from "../src/bridge/model-catalog.ts";

test("model/list answers the shared catalog with wire model ids", async () => {
  const output = captureBridgeJsonRpcOutput();
  try {
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: BRIDGE_REQUEST_METHODS.modelList,
        params: {},
      }),
    );
    const deadline = Date.now() + 1000;
    let reply;
    while (reply === undefined && Date.now() < deadline) {
      reply = output.takeMessages().find((message) => message.id === 7);
      if (reply === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(reply, "no model/list reply within 1s");
    assert.deepEqual(reply.result, {
      models: AMP_WIRE_MODELS,
      selectedOnlyModels: [],
    });
    // The wire entries are the fallback entries plus the required raw model
    // string; nothing else may drift between the two servings.
    assert.deepEqual(
      AMP_WIRE_MODELS.map(({ model: _model, ...rest }) => rest),
      AMP_FALLBACK_MODELS.map((entry) =>
        Object.assign({}, entry, {
          supportedReasoningEfforts: [...entry.supportedReasoningEfforts],
        }),
      ),
    );
    for (const entry of AMP_WIRE_MODELS) assert.equal(entry.model, entry.id);
  } finally {
    output.restore();
  }
});
