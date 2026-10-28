import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { packagePath } from "../data-source";
import { checkApp, lintApp } from "./appLint";

/** `line severity: first words` per finding, enough to tell them apart. */
const found = (html: string) => lintApp(html).map(({ line, severity, message }) => `${line} ${severity}: ${message.split(/[.:]/)[0]}`);

describe("lintApp", () => {
  // These are what agents copy, so they must be clean.
  it("finds nothing in the example apps", async () => {
    const files = (await readdir(packagePath("gallery", "app"))).filter((file) => file.endsWith(".html"));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const file of files) {
      expect(lintApp(await readFile(packagePath("gallery", "app", file), "utf8")), file).toEqual([]);
    }
  });

  it("reports a classic script's syntax error at its line in the page", () => {
    const html = "<p>Score</p>\n<script>\n  const total = 1;\n  const data = await load();\n</script>";
    expect(lintApp(html)).toEqual([
      expect.objectContaining({ line: 4, column: 16, severity: "error", message: expect.stringContaining("no top-level await") }),
    ]);
    expect(found("<script>let x = ;</script>")).toEqual(["1 error: script doesn't parse"]);
    // V8 reads `await (…)` in a classic script as a call and reports something else; it's still the await.
    expect(lintApp("<script>\nconst rows = await (await load()).json();\n</script>")).toEqual([
      expect.objectContaining({ line: 2, column: 14, message: expect.stringContaining("no top-level await") }),
    ]);
  });

  it("leaves module scripts' syntax alone but rejects what they import", () => {
    const html = '<script type="module">\nimport * as THREE from "three";\nimport "https://esm.sh/confetti";\nconst x = await Promise.resolve(1);\n</script>';
    expect(found(html)).toEqual(['2 error: import "three" can\'t load', '3 error: import "https']);
  });

  it("makes network use an error and ignores it in comments and strings", () => {
    const html = [
      '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter">',
      "<style>@import url(https://x.test/a.css); .hero { background: url(//x.test/bg.png) }</style>",
      '<img src="https://x.test/cat.png" alt=""><img src="data:image/png;base64,AA" alt="">',
      "<!-- <img src=\"https://x.test/hidden.png\"> -->",
      "<script>",
      '  // fetch("/comment")',
      '  const note = "fetch(in a string)";',
      '  function load() { return fetch("/api").then((r) => r.json()); }',
      '  const socket = new WebSocket("wss://x.test");',
      "  const cache = { fetch() {} }; cache.fetch();",
      "</script>",
    ].join("\n");
    expect(found(html)).toEqual([
      "1 error: <script src=\"https",
      "2 error: <link href=\"https",
      "3 error: @import https",
      "3 error: url(//x",
      "4 error: <img src=\"https",
      "9 error: fetch() can't reach anything",
      "10 error: WebSocket can't connect",
    ]);
  });

  it("warns about dialogs, links that can't open, indexedDB and viewport heights, with the fix", () => {
    const html = [
      "<style>html, body { height: 100dvh }</style>",
      '<a href="docs.html">Docs</a> <a href="https://x.test" target="_blank">Site</a>',
      "<button onclick=\"alert('saved')\">Save</button>",
      "<script>",
      '  function ask() { if (confirm("Sure?")) window.open("https://x.test"); }',
      '  const db = indexedDB.open("x");',
      "</script>",
    ].join("\n");
    const findings = lintApp(html);
    expect(findings.map(({ line, severity }) => `${line} ${severity}`)).toEqual(["1 warning", "2 warning", "3 warning", "5 warning", "5 warning", "6 warning"]);
    expect(findings[1].message).toContain("only https links open");
    expect(findings[2].message).toContain("Draw the message in the page");
    expect(findings[5].message).toContain("localStorage");
  });

  it("warns about genui.answer and genui.openLink outside a function, not inside one", () => {
    const html = [
      "<script>",
      '  genui.answer("at load");',
      '  button.addEventListener("click", () => genui.answer("clicked"));',
      '  const share = () => genui.openLink("https://x.test")',
      '  if (ready) { genui.openLink("https://x.test"); }',
      '  function send() { if (ok) { genui.answer("x"); } }',
      '  const handlers = { click() { genui.answer("y"); } };',
      "</script>",
      '<button onclick="genui.answer(\'from the attribute\')">Send</button>',
    ].join("\n");
    expect(found(html)).toEqual(["2 warning: genui", "5 warning: genui"]);
  });
});

describe("checkApp", () => {
  it("says plainly when there is nothing to fix", () => {
    expect(checkApp("<p>Hello</p>")).toEqual({ ok: true, report: expect.stringMatching(/^No errors or warnings in the app\./) });
  });

  // Warnings alone don't fail the check: the app still runs.
  it("fails only on errors", () => {
    expect(checkApp('<script>function f() { alert("x"); }</script>').ok).toBe(true);
    const { ok, report } = checkApp('<script src="https://x.test/a.js"></script>');
    expect(ok).toBe(false);
    expect(report).toMatch(/^Fix before replying[^\n]*\n1:14 error: <script src=/);
  });
});
