import assert from "node:assert/strict";
import test from "node:test";

import {
  followsBbDeliveryDefault,
  threadSendMode,
} from "../lib/delivery.ts";

test("queue waits behind an active thread", () => {
  assert.equal(threadSendMode("Queue", true), "queue-if-active");
});

test("steer joins an active thread", () => {
  assert.equal(threadSendMode("Steer", false), "steer-if-active");
});

test("default follows bb when Enter queues active threads", () => {
  assert.equal(threadSendMode("Default", false), "queue-if-active");
});

test("default follows bb when Enter steers active threads", () => {
  assert.equal(threadSendMode("Default", true), "steer-if-active");
});

test("stored lowercase overrides remain compatible", () => {
  assert.equal(threadSendMode("queue", true), "queue-if-active");
  assert.equal(threadSendMode("steer", false), "steer-if-active");
});

test("only default reads bb's delivery preference", () => {
  assert.equal(followsBbDeliveryDefault("Default"), true);
  assert.equal(followsBbDeliveryDefault("default"), true);
  assert.equal(followsBbDeliveryDefault("Queue"), false);
  assert.equal(followsBbDeliveryDefault("Steer"), false);
});
