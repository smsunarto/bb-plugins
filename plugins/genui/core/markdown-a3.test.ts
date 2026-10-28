import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compile, dataKey, evaluate, formatDiagnostics, initialState, parseDataFile, toMarkdown } from "./index";

function markdown(source: string, files: Record<string, string> = {}): string {
  const result = compile(source);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map(Object.entries(files).map(([path, text]) => [dataKey({ path, raw: false }), parseDataFile(path, text)]));
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

/** A gallery fixture's text: real tool output. */
function gallery(path: string): string {
  return readFileSync(new URL(`../gallery/${path}`, import.meta.url), "utf8");
}

describe("toMarkdown: StackTrace", () => {
  it("lists each error with its frames, the first app frame marked and library runs folded", () => {
    expect(markdown(`StackTrace(Load("t.txt"), "Pricing")`, { "t.txt": gallery("data/traces/node-cause.txt") })).toBe(`**Pricing**

**Error**: Couldn't price cart c_42

\`\`\`
→ priceCart (data/traces/shop/cart.mjs:15:11)
  data/traces/shop/cart.mjs:19:13
  async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:101:5)
  … 2 more as in the cause
\`\`\`

Caused by: **TypeError**: Cannot read properties of undefined (reading 'toEur')

\`\`\`
→ lineTotal (data/traces/shop/pricing.mjs:10:46)
  data/traces/shop/cart.mjs:13:37
  Array.map (<anonymous>)
  priceCart (data/traces/shop/cart.mjs:13:23)
  data/traces/shop/cart.mjs:19:13
  … 3 library frames
\`\`\``);
  });

  it("puts Python's raised exception first and names how each one is chained", () => {
    expect(markdown(`StackTrace(Load("t.txt"))`, { "t.txt": gallery("data/traces/python-chain.txt") })).toBe(`**FileNotFoundError**: [Errno 2] No such file or directory: 'deploy.defaults.json'

\`\`\`
→ read_settings (data/traces/py/settings.py:10)
  main (data/traces/py/deploy.py:12)
  <module> (data/traces/py/deploy.py:17)
\`\`\`

While handling: **settings.SettingsError**: data/traces/py/deploy.json is not valid JSON

\`\`\`
→ read_settings (data/traces/py/settings.py:15)
  main (data/traces/py/deploy.py:10)
\`\`\`

Caused by: **json.decoder.JSONDecodeError**: Expecting property name enclosed in double quotes: line 4 column 3 (char 45)

\`\`\`
  … 3 library frames
→ read_settings (data/traces/py/settings.py:13)
\`\`\``);
  });

  it("numbers an AggregateError's errors and keeps their printed properties", () => {
    expect(markdown(`StackTrace(Load("t.txt"))`, { "t.txt": gallery("data/traces/node-aggregate.txt") })).toBe(`**AggregateError**: All promises were rejected

Error 1 of 2: **TypeError**: fetch failed

Caused by: **Error**: connect ECONNREFUSED 127.0.0.1:4319  
errno -61 · code ECONNREFUSED · syscall connect · address 127.0.0.1 · port 4319

\`\`\`
  TCPConnectWrap.afterConnect [as oncomplete] (node:net:2021:16)
\`\`\`

Error 2 of 2: **TypeError**: fetch failed

Caused by: **Error**: connect ECONNREFUSED 127.0.0.1:4320  
errno -61 · code ECONNREFUSED · syscall connect · address 127.0.0.1 · port 4320

\`\`\`
  TCPConnectWrap.afterConnect [as oncomplete] (node:net:2021:16)
\`\`\``);
  });

  it("reads {name, message, stack} and says when the input is no trace", () => {
    expect(markdown(`StackTrace({name: "TypeError", message: "x is undefined", stack: "render@http://localhost:5173/src/app.js:3:9"})`)).toBe(
      "**TypeError**: x is undefined\n\n```\n→ render (src/app.js:3:9)\n```",
    );
    expect(markdown(`StackTrace(3)`)).toBe("_(StackTrace needs an error's text with its stack, or {name, message, stack})_");
  });
});

describe("toMarkdown: Logs", () => {
  it("shows the command, exit code and counts, the tail, and the first error when it is earlier", () => {
    const text = markdown(`Logs(Load("run.log"), "npx vitest run", 1)`, { "run.log": gallery("data/logs/vitest-run.log") });
    const [head, earlier, ...rest] = text.split("\n\n");
    expect(head).toBe("`$ npx vitest run` · 🔴 exit 1 · 87 lines · 3 errors");
    expect(earlier).toBe("_… 57 earlier lines_");
    expect(rest.join("\n\n")).toContain("```text\n+   \"Coverage\",");
    expect(rest.join("\n\n")).toContain("      Tests  1 failed | 460 passed (461)");
    expect(text.endsWith("First error, line 16: `     × has an example for every component 15ms`")).toBe(true);
    // No ANSI codes reach the text.
    expect(text).not.toContain("\u001b");
  });

  it("formats JSON records with their shared fields once and folds repeats", () => {
    const text = markdown(`Logs(Load("worker.jsonl"), "node worker.mjs")`, { "worker.jsonl": gallery("data/logs/thumbnailer.jsonl") });
    expect(text.split("\n\n")[0]).toBe(
      "`$ node worker.mjs` · 20 lines · 1 fatal · 1 error · 6 warnings · pid 23437 · hostname build-07 · service thumbnailer · times UTC",
    );
    expect(text).toContain("00:15:31.894 queue empty, polling again in 2s  queue=thumbnails waiting=0  (× 6)\n00:15:31.917 shutting down  signal=SIGTERM");
    expect(text).toContain("Error: unsupported image format: uploads/2026/10/IMG_2291.heic\n    at resize (file:///srv/thumbnailer/worker.mjs:7:41)");
  });

  it("reads lines, a command with backticks, and empty output", () => {
    expect(markdown('Logs(["[info] up", "[info] up", "[error] down"], "echo `date`", 0)')).toBe(
      "`` $ echo `date` `` · 🟢 exit 0 · 3 lines · 1 error\n\n```text\n[info] up  (× 2)\n[error] down\n```",
    );
    expect(markdown('Logs("")')).toBe("**Output** · 0 lines\n\n_No output._");
    expect(markdown("Logs(12)")).toBe("_(Logs needs text, a list of lines, or a list of JSON log records)_");
  });
});
