import assert from "node:assert/strict";
import { test } from "bun:test";

import { parseDeliveryEnvelope, rendererHttpPaths, rendererHttpUrl } from "./renderer-http.ts";

test("renderer HTTP URLs stay plugin-scoped", () => {
  assert.equal(
    rendererHttpUrl("notify", rendererHttpPaths.next),
    "/api/v1/plugins/notify/http/mailbox/next",
  );
});

test("delivery envelopes reject invalid ids and thread targets", () => {
  const base = {
    id: "delivery-1",
    notification: { title: "Build", body: "finished", threadId: "thr_1", silent: true },
  };
  assert.deepEqual(parseDeliveryEnvelope(base), base);
  assert.equal(parseDeliveryEnvelope({ ...base, id: "" }), null);
  assert.equal(
    parseDeliveryEnvelope({
      ...base,
      notification: { ...base.notification, threadId: "bad id" },
    }),
    null,
  );
});
