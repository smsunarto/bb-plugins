import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isThreadId,
  MAX_RUN_SECONDS,
  notificationLines,
  oneLine,
  parseSeconds,
  parseSendArgs,
  plainText,
  suppressionReason,
  threadLabel,
} from "../format.ts";

test("oneLine collapses whitespace and leaves short text alone", () => {
  assert.equal(oneLine("  a\n\n b\tc  ", 40), "a b c");
  assert.equal(oneLine("exactly ten", 11), "exactly ten");
});

test("oneLine clips with an ellipsis and never exceeds the budget", () => {
  const clipped = oneLine("abcdefghij", 5);
  assert.equal(clipped, "abcd…");
  assert.equal(clipped.length, 5);
  // The ellipsis replaces a character rather than being appended to a full line.
  assert.ok(oneLine("x".repeat(200), 160).length <= 160);
});

test("oneLine does not leave a dangling space before the ellipsis", () => {
  assert.equal(oneLine("ab cdefg", 4), "ab…");
});

test("oneLine clips without splitting a Unicode code point", () => {
  assert.equal(oneLine("abc😀def", 5), "abc😀…");
  assert.equal(oneLine("abc", 0), "");
});

test("threadLabel prefers the title, then the fallback, then a constant", () => {
  assert.equal(threadLabel({ title: "Real", titleFallback: "Fall" }), "Real");
  assert.equal(threadLabel({ title: "  ", titleFallback: "Fall" }), "Fall");
  assert.equal(threadLabel({ title: null, titleFallback: null }), "Untitled thread");
  assert.equal(threadLabel({ title: "", titleFallback: "   " }), "Untitled thread");
});

test("notificationLines titles with the thread and tags with the project", () => {
  assert.deepEqual(notificationLines("git", "Fix the poll", "Done."), {
    title: "Fix the poll",
    body: "[git] Done.",
  });
});

test("notificationLines omits empty brackets when there is no project", () => {
  assert.deepEqual(notificationLines(null, "T", "Done."), { title: "T", body: "Done." });
  assert.deepEqual(notificationLines("", "T", "Done."), { title: "T", body: "Done." });
});

test("the assembled notification body can be clipped to its final budget", () => {
  const { body } = notificationLines("project", "Thread", "😀".repeat(200));
  const clipped = oneLine(body, 160);
  assert.equal(Array.from(clipped).length, 160);
  assert.ok(clipped.startsWith("[project] "));
  assert.ok(clipped.endsWith("…"));
});

test("plainText unwraps emphasis, code, links, and images", () => {
  assert.equal(plainText("**bold** and *italic*"), "bold and italic");
  assert.equal(plainText("__bold__ and _italic_"), "bold and italic");
  assert.equal(plainText("~~gone~~"), "gone");
  assert.equal(plainText("see `format.ts`"), "see format.ts");
  assert.equal(plainText("[details](https://example.com)"), "details");
  assert.equal(plainText("![alt](https://example.com/a.png)"), "alt");
});

test("plainText strips line-leading furniture", () => {
  assert.equal(plainText("## Heading"), "Heading");
  assert.equal(plainText("> quoted"), "quoted");
  assert.equal(plainText("- bullet"), "bullet");
  assert.equal(plainText("1. numbered"), "numbered");
  assert.equal(plainText("---"), "");
});

test("plainText leaves prose that only looks like syntax", () => {
  assert.equal(plainText("snake_case_name"), "snake_case_name");
  assert.equal(plainText("2 * 3 = 6"), "2 * 3 = 6");
});

test("plainText restores backslash-escaped markers as literals", () => {
  assert.equal(plainText(String.raw`\*not italic\*`), "*not italic*");
  assert.equal(plainText(String.raw`a \_ b`), "a _ b");
  // Escaped markers are parked in the private use area while syntax is
  // stripped. Each must come back as itself; a leftover would reach the
  // notification as an unrenderable box.
  const restored = plainText(String.raw`\*\_\#\[\]\~\|`);
  assert.equal(restored, "*_#[]~|");
  for (const char of restored) {
    assert.ok(char.codePointAt(0)! < 0xe000, `parked character leaked: ${char}`);
  }
});

test("plainText survives the README's own example", () => {
  assert.equal(
    plainText("**Root cause: the trick cannot work.** See `format.ts` for [details](url)."),
    "Root cause: the trick cannot work. See format.ts for details.",
  );
});

test("isThreadId accepts bb slugs and rejects anything that could escape", () => {
  assert.ok(isThreadId("abc123"));
  assert.ok(isThreadId("a_b-c"));
  assert.ok(!isThreadId(""));
  assert.ok(!isThreadId("../etc/passwd"));
  assert.ok(!isThreadId('a"b'));
  assert.ok(!isThreadId("a b"));
  assert.ok(!isThreadId("x".repeat(65)));
});

test("parseSeconds treats malformed values as off and caps extreme values", () => {
  assert.equal(parseSeconds("0"), 0);
  assert.equal(parseSeconds(" 2.5 "), 2.5);
  assert.equal(parseSeconds("abc"), 0);
  assert.equal(parseSeconds("5seconds"), 0);
  assert.equal(parseSeconds(""), 0);
  assert.equal(parseSeconds("-4"), 0);
  assert.equal(parseSeconds("Infinity"), 0);
  assert.equal(parseSeconds("1e100"), MAX_RUN_SECONDS);
});

test("suppressionReason applies the default quiet filters", () => {
  const off = { includeHiddenThreads: false, includeChildThreads: false };
  assert.equal(suppressionReason({ visibility: "visible", parentThreadId: null }, off), null);
  assert.equal(
    suppressionReason({ visibility: "hidden", parentThreadId: null }, off),
    "hidden thread",
  );
  assert.equal(
    suppressionReason({ visibility: "visible", parentThreadId: "p" }, off),
    "child thread",
  );
});

test("suppressionReason lets both filters be opened", () => {
  const on = { includeHiddenThreads: true, includeChildThreads: true };
  assert.equal(suppressionReason({ visibility: "hidden", parentThreadId: "p" }, on), null);
});

test("parseSendArgs reads a positional message", () => {
  const parsed = parseSendArgs(["Build", "is", "green"]);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value, { message: "Build is green", title: null, threadId: null });
});

test("parseSendArgs accepts both flag spellings", () => {
  const spaced = parseSendArgs(["hi", "--title", "CI"]);
  const equals = parseSendArgs(["hi", "--title=CI"]);
  assert.ok(spaced.ok && equals.ok);
  assert.equal(spaced.value.title, "CI");
  assert.equal(equals.value.title, "CI");
});

test("parseSendArgs keeps an equals sign inside a flag value", () => {
  const parsed = parseSendArgs(["hi", "--title=a=b"]);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.title, "a=b");
});

test("parseSendArgs falls back to --message when there is no positional", () => {
  const parsed = parseSendArgs(["--message", "from a flag"]);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.message, "from a flag");
});

test("parseSendArgs rejects a misspelled flag instead of eating the next word", () => {
  const parsed = parseSendArgs(["hi", "--titel", "CI"]);
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /unknown flag: --titel/);
});

test("parseSendArgs rejects a flag with no value", () => {
  assert.ok(!parseSendArgs(["hi", "--title"]).ok);
  const swallowed = parseSendArgs(["hi", "--title", "--thread", "abc"]);
  assert.ok(!swallowed.ok);
  assert.match(swallowed.error, /--title needs a value/);
});

test("parseSendArgs rejects a thread id that could not be opened", () => {
  const parsed = parseSendArgs(["hi", "--thread", "../nope"]);
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /not a thread id/);
});

test("parseSendArgs accepts a well-formed thread override", () => {
  const parsed = parseSendArgs(["hi", "--thread", "t_abc-123"]);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.threadId, "t_abc-123");
});

test("parseSendArgs treats -- as the end of the flags", () => {
  const parsed = parseSendArgs(["--", "--title", "is the message"]);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.message, "--title is the message");
  assert.equal(parsed.value.title, null);
});

test("parseSendArgs demands a message", () => {
  assert.ok(!parseSendArgs([]).ok);
  assert.ok(!parseSendArgs(["   "]).ok);
  const parsed = parseSendArgs(["--title", "CI"]);
  assert.ok(!parsed.ok);
  assert.match(parsed.error, /usage: bb notify send/);
});
