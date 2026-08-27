// Ported from the ACP bridge's routing tests (3607ed7^, bridge-core.test.ts)
// with two wire adaptations: prompt parts join with "\n\n" (`promptText`
// parity) and the native block union replaces ACP resource blocks with typed
// image blocks and `agent-only` text visibility.
import assert from "node:assert/strict";
import { test } from "bun:test";
import { routeAmpPrompt } from "../src/bridge/prompt-routing.ts";

const textPrompt = (text: string) => [{ type: "text" as const, text }];

test("a case-insensitive standalone /orb token routes from anywhere and is removed", () => {
  for (const [input, expected] of [
    ["/orb fix the test", "fix the test"],
    ["fix /ORB the test", "fix the test"],
    ["fix the test /oRb", "fix the test"],
    ["first line\n/orb\nlast line", "first line last line"],
  ]) {
    const routed = routeAmpPrompt(textPrompt(input));
    assert.equal(routed.prompt.replace(/\s+/gu, " ").trim(), expected);
    assert.equal(routed.prompt.includes("/orb"), false);
    assert.equal(routed.requestedTarget, "orb");
    assert.equal(routed.directiveOnly, false);
  }
});

test("Orb routing strips only the token and preserves unrelated whitespace", () => {
  assert.deepEqual(routeAmpPrompt(textPrompt("  keep\n/orb\n  indentation  ")), {
    prompt: "  keep\n\n  indentation  ",
    requestedTarget: "orb",
    directiveOnly: false,
  });
});

test("a prompt that is only the /orb token is directive-only", () => {
  for (const input of ["/orb", "  /orb \n"]) {
    const routed = routeAmpPrompt(textPrompt(input));
    assert.equal(routed.requestedTarget, "orb");
    assert.equal(routed.directiveOnly, true);
  }
});

test("Orb routing ignores partial words and text after an image block still routes", () => {
  assert.deepEqual(routeAmpPrompt(textPrompt("check /orbital behavior")), {
    prompt: "check /orbital behavior",
    requestedTarget: null,
    directiveOnly: false,
  });
  assert.deepEqual(
    routeAmpPrompt([
      { type: "image", url: "https://example.test/screen.png" },
      ...textPrompt("/orb go"),
    ]),
    { prompt: " go", requestedTarget: "orb", directiveOnly: false },
  );
});

test("Orb routing ignores bb system instructions and later plugin context", () => {
  const system = "<system_instructions>\nNever write /orb by itself.\n</system_instructions>";
  const context = 'Context for @issue (resolved by plugin "tracker"):\n\n/orb';
  assert.deepEqual(
    routeAmpPrompt([
      { type: "text", text: system },
      { type: "text", text: "work locally" },
      { type: "text", text: context },
    ]),
    {
      prompt: `${system}\n\nwork locally\n\n${context}`,
      requestedTarget: null,
      directiveOnly: false,
    },
  );

  const routed = routeAmpPrompt([
    { type: "text", text: system },
    { type: "text", text: "use /orb for this task" },
    { type: "text", text: context },
  ]);
  assert.equal(routed.requestedTarget, "orb");
  assert.equal(routed.prompt.includes("use /orb"), false);
  assert.equal(routed.prompt.includes("Never write /orb"), true);
  assert.equal(routed.prompt.endsWith(context), true);
});

test("agent-only text blocks stay in the prompt but never route", () => {
  assert.deepEqual(
    routeAmpPrompt([
      { type: "text", text: "/orb do this quietly", visibility: "agent-only" },
      ...textPrompt("visible follow-up"),
    ]),
    {
      prompt: "/orb do this quietly\n\nvisible follow-up",
      requestedTarget: null,
      directiveOnly: false,
    },
  );
});

test("Orb routing fails safe for bb-generated primary text", () => {
  for (const generated of [
    "[bb message from thread:thr_source]\n\n/orb do this",
    "[bb system]\n\n/orb continue the task",
    "Please continue.",
    "[image attachment: https://example.test/orb.png]",
  ]) {
    const routed = routeAmpPrompt([
      { type: "text", text: generated },
      { type: "text", text: "/orb hidden follow-up" },
    ]);
    assert.equal(routed.requestedTarget, null);
    assert.equal(routed.prompt, `${generated}\n\n/orb hidden follow-up`);
  }
});
