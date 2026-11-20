import { describe, expect, test } from "vitest";
import { ASK_OPTION_MAX, askBlockers } from "./asks.ts";
import { captainHost, newCaptain } from "./test-host.ts";

/** The blockers for a decision ask on BBPLUGINS-1 with these options. */
function blockersFor(options: string[]) {
  return askBlockers({
    kind: "decision",
    taskKey: "BBPLUGINS-1",
    text: "Pick the cache backend",
    detail: "Builds re-download deps.",
    options,
  });
}

describe("an ask's option labels", () => {
  test("12 characters is accepted and 13 is refused, naming the option and the limit", () => {
    expect(ASK_OPTION_MAX).toBe(12);
    expect(blockersFor(["Redis cache!", "SQLite"])).toEqual([]);
    expect(blockersFor(["Redis caches!", "SQLite"])).toEqual([
      {
        reason:
          'option "Redis caches!" is 13 characters; an option is at most 12, so the buttons fit on one row',
        fix: 'shorten it to a label, such as "Redis"; move the detail into --detail-file',
      },
    ]);
  });

  test("each long option gets its own blocker; surrounding space is not counted", () => {
    expect(blockersFor(["  Redis cache!  ", "SQLite"])).toEqual([]);
    expect(blockersFor(["Use the Redis cache", "Use SQLite on disk"]).map((b) => b.reason)).toEqual(
      [
        'option "Use the Redis cache" is 19 characters; an option is at most 12, so the buttons fit on one row',
        'option "Use SQLite on disk" is 18 characters; an option is at most 12, so the buttons fit on one row',
      ],
    );
  });

  test("emoji and accented letters count as one character each", () => {
    const family = "👨‍👩‍👧‍👦"; // 7 code points, 11 UTF-16 units, one grapheme
    const accented = "é"; // e + combining acute
    expect(blockersFor(["🚀".repeat(12), "Hold"])).toEqual([]);
    expect(blockersFor(["🚀".repeat(13), "Hold"])[0]?.reason).toContain("is 13 characters");
    expect(blockersFor([`${family} Ship it`, "Hold"])).toEqual([]);
    expect(blockersFor([`Caf${accented} ${family}${"x".repeat(6)}`, "Hold"])).toEqual([]);
    expect(blockersFor([`${accented.repeat(13)}`, "Hold"])[0]?.reason).toContain(
      "is 13 characters",
    );
  });

  test("an empty option is refused on its own", () => {
    expect(blockersFor(["  ", "SQLite"])).toEqual([
      { reason: "an option is empty", fix: "drop the empty --option" },
    ]);
  });
});

describe("the ask command", () => {
  test("refuses a long option with the error text, and accepts a 12-character first option although the comment adds (recommended)", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    host.addTask("BBPLUGINS-1", { title: "Render PR images" });
    const as = (argv: string[]) => host.harness.behavior.runCli(argv, { threadId: captainId });
    const ask = (first: string) =>
      as([
        "ask",
        "Pick the cache backend",
        "--task",
        "BBPLUGINS-1",
        "--option",
        first,
        "--option",
        "SQLite",
        "--detail",
        "Builds re-download deps.",
      ]);

    const refused = await ask("Redis caches!");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr + refused.stdout).toContain(
      'option "Redis caches!" is 13 characters; an option is at most 12, so the buttons fit on one row',
    );
    expect(refused.stderr + refused.stdout).toContain("move the detail into --detail-file");
    expect(
      host.server.store.findOpenAsk(captainId, "decision", "BBPLUGINS-1", "Pick the cache backend"),
    ).toBeNull();

    const opened = await ask("Redis cache!");
    expect(opened.exitCode, opened.stderr).toBe(0);
    const comment = host.tasks.comments.find((c) => c.body.startsWith("Asked:"));
    expect(comment?.body).toContain("1. Redis cache! (recommended)");
  });

  test("an open ask stored before the cap still reads and answers", async () => {
    const host = await captainHost();
    const captainId = await newCaptain(host);
    host.addTask("BBPLUGINS-1", { title: "Render PR images" });
    const longLabel = "Keep the in-memory cache for now";
    host.server.store.openAsk({
      captainId,
      taskKey: "BBPLUGINS-1",
      kind: "decision",
      text: "Pick the cache backend",
      detail: "Builds re-download deps.",
      options: [longLabel, "Move to Redis"],
      askedAt: 1_000,
    });
    const rpc = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);

    expect(await rpc("asks", { captainId })).toEqual({
      items: [expect.objectContaining({ key: "ask:a1", options: [longLabel, "Move to Redis"] })],
    });
    expect(await rpc("resolveAsk", { askId: "a1", answer: longLabel })).toEqual({
      state: "answered",
      warnings: [],
    });
    expect(host.tasks.comments.at(-1)?.body).toBe(`Answered: ${longLabel} (a1)`);
  });
});
