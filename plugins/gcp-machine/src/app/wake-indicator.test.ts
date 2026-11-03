import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { createWakeIndicator } from "./wake-indicator.ts";

installTestPluginRuntime();
test("the footer icon renders the requested connected, waking, and offline colors", () => {
  const indicator = createWakeIndicator();
  for (const [state, color] of [
    ["awake", "var(--success)"],
    ["waking", "var(--warning)"],
    ["offline", "inherit"],
  ] as const) {
    indicator.set(state);
    const html = renderToStaticMarkup(createElement(indicator.Icon, { className: "size-full" }));
    assert.ok(html.includes(`data-gcp-state="${state}"`));
    assert.ok(html.includes(`color:${color}`));
    assert.ok(html.includes(`GCP machine: ${state}`));
  }
});

test("separate frontend generations do not share stale connection colors", () => {
  const previous = createWakeIndicator();
  previous.set("awake");
  const next = createWakeIndicator();
  assert.match(renderToStaticMarkup(createElement(next.Icon)), /data-gcp-state="offline"/);
});
