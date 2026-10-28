import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseDataFile } from "./data";
import { frameRows, memberPlaces, readTrace, relationLabel, sourcePath, splitHeader, type Trace } from "./stack-trace";
import { stackFrame } from "./test-results";
import type { Value } from "./types";

/** Real traces in gallery/data/traces (see the gallery examples). */
function fixture(name: string): Value {
  const loaded = parseDataFile(name, readFileSync(new URL(`../gallery/data/traces/${name}`, import.meta.url), "utf8"));
  if (!loaded.ok) throw new Error(loaded.error);
  return loaded.value;
}

function read(value: Value): Trace {
  const result = readTrace(value);
  if (!result.ok) throw new Error(result.error);
  return result.trace;
}

/** Each section as `relation depth type: message` and its frames as `fn path:line (app|lib)`. */
function outline(trace: Trace): string[] {
  return trace.sections.flatMap((s) => [
    `${s.relation ?? "top"} ${s.depth} ${s.type}: ${s.message}`,
    ...s.frames.map((f) => `  ${f.fn ?? "-"} ${f.location === null ? "-" : `${f.location.path}:${f.location.line}`} ${f.app ? "app" : "lib"}`),
  ]);
}

describe("readTrace: JavaScript", () => {
  it("reads Node's uncaught error with its [cause], skipping the source preamble", () => {
    const trace = read(fixture("node-cause.txt"));
    expect(trace.language).toBe("javascript");
    expect(trace.notes).toEqual(["Node.js v26.8.1"]);
    expect(outline(trace)).toEqual([
      "top 0 Error: Couldn't price cart c_42",
      "  priceCart data/traces/shop/cart.mjs:15 app",
      "  - data/traces/shop/cart.mjs:19 app",
      "  async asyncRunEntryPointWithESMLoader - lib",
      "cause 0 TypeError: Cannot read properties of undefined (reading 'toEur')",
      "  lineTotal data/traces/shop/pricing.mjs:10 app",
      "  - data/traces/shop/cart.mjs:13 app",
      "  Array.map - lib",
      "  priceCart data/traces/shop/cart.mjs:13 app",
      "  - data/traces/shop/cart.mjs:19 app",
      "  ModuleJob.run - lib",
      "  - - lib",
      "  async asyncRunEntryPointWithESMLoader - lib",
    ]);
    expect(trace.sections[0].omitted).toBe(2);
    expect(trace.sections[1].frames[0].location).toMatchObject({ column: 46 });
  });

  it("reads an AggregateError's errors, their causes and printed properties", () => {
    const trace = read(fixture("node-aggregate.txt"));
    expect(outline(trace)).toEqual([
      "top 0 AggregateError: All promises were rejected",
      "member 1 TypeError: fetch failed",
      "cause 1 Error: connect ECONNREFUSED 127.0.0.1:4319",
      "  TCPConnectWrap.afterConnect [as oncomplete] - lib",
      "member 1 TypeError: fetch failed",
      "cause 1 Error: connect ECONNREFUSED 127.0.0.1:4320",
      "  TCPConnectWrap.afterConnect [as oncomplete] - lib",
    ]);
    expect(trace.sections[2].fields).toEqual([
      ["errno", "-61"],
      ["code", "ECONNREFUSED"],
      ["syscall", "connect"],
      ["address", "127.0.0.1"],
      ["port", "4319"],
    ]);
    expect(memberPlaces(trace.sections).map((place) => (place === null ? null : `${place.index}/${place.count}`))).toEqual([null, "1/2", null, "2/2", null]);
    expect(relationLabel("member", { index: 2, count: 2 })).toBe("Error 2 of 2");
  });

  it("reads AggregateError members with stacks, ending in commas", () => {
    // node -e 'await Promise.any([check("eu"), check("us")])' (Node 26), paths kept as printed.
    const text = `node:internal/modules/run_main:107
    triggerUncaughtException(
    ^

[AggregateError: All promises were rejected] {
  [errors]: [
    Error: eu is down
        at check (file:///private/tmp/agg.mjs:1:46)
        at file:///private/tmp/agg.mjs:2:20
        at ModuleJob.run (node:internal/modules/esm/module_job:569:25),
    Error: us is down
        at check (file:///private/tmp/agg.mjs:1:46)
        at file:///private/tmp/agg.mjs:2:33
  ]
}`;
    expect(outline(read(text))).toEqual([
      "top 0 AggregateError: All promises were rejected",
      "member 1 Error: eu is down",
      "  check file:///private/tmp/agg.mjs:1 app",
      "  - file:///private/tmp/agg.mjs:2 app",
      "  ModuleJob.run - lib",
      "member 1 Error: us is down",
      "  check file:///private/tmp/agg.mjs:1 app",
      "  - file:///private/tmp/agg.mjs:2 app",
    ]);
  });

  it("reads Safari's fn@url frames from {name, message, stack}, URLs as the app's paths", () => {
    const trace = read(fixture("browser-error.json"));
    expect(outline(trace)).toEqual([
      "top 0 TypeError: undefined is not an object (evaluating 'result.score.toFixed')",
      "  - data/traces/web/search.js:6 app",
      "  map - lib",
      "  renderResults data/traces/web/search.js:4 app",
      "  onResponse data/traces/web/app.js:6 app",
    ]);
  });

  it("reads Chrome's stacks with dev-server URLs, queries and Vite's /@fs/ and dependency paths", () => {
    // Chromium's error.stack for the same page (playwright), plus Vite's URL shapes.
    const trace = read(`Uncaught TypeError: Cannot read properties of undefined (reading 'toFixed')
    at http://127.0.0.1:5173/data/traces/web/search.js:6:59
    at Array.map (<anonymous>)
    at renderResults (http://127.0.0.1:5173/src/search.ts?t=1760000000000:4:25)
    at commitRoot (http://localhost:5173/node_modules/.vite/deps/react-dom_client.js?v=3f2a:9:1)
    at load (http://localhost:5173/@fs/Users/me/shared/load.ts:3:9)`);
    expect(outline(trace)).toEqual([
      "top 0 TypeError: Cannot read properties of undefined (reading 'toFixed')",
      "  - data/traces/web/search.js:6 app",
      "  Array.map - lib",
      "  renderResults src/search.ts:4 app",
      "  commitRoot node_modules/.vite/deps/react-dom_client.js:9 lib",
      "  load /Users/me/shared/load.ts:3 app",
    ]);
  });

  it("reads `Caused by:` chains, ANSI colours, multi-line messages and Windows paths", () => {
    const trace = read(
      "\u001b[31mError: deploy failed\u001b[39m\n  two lines of message\n    at deploy (C:\\work\\app\\deploy.ts:12:5)\n    at main (/repo/src/main.ts:3:1)\nCaused by: Error: timeout ✗ 東京\n    at wait (/repo/src/wait.ts:9:9)",
    );
    expect(outline(trace)).toEqual([
      "top 0 Error: deploy failed\ntwo lines of message",
      "  deploy C:\\work\\app\\deploy.ts:12 app",
      "  main /repo/src/main.ts:3 app",
      "cause 0 Error: timeout ✗ 東京",
      "  wait /repo/src/wait.ts:9 app",
    ]);
  });

  it("reads a serialized error with nested cause and errors objects", () => {
    const trace = read({
      name: "AggregateError",
      message: "2 uploads failed",
      stack: "AggregateError: 2 uploads failed\n    at uploadAll (/repo/src/upload.ts:20:11)",
      errors: [{ name: "Error", message: "a.png: 413", cause: { message: "body too large" } }, { name: "Error", message: "b.png: 500" }],
    });
    expect(outline(trace)).toEqual([
      "top 0 AggregateError: 2 uploads failed",
      "  uploadAll /repo/src/upload.ts:20 app",
      "member 1 Error: a.png: 413",
      "cause 1 : body too large",
      "member 1 Error: b.png: 500",
    ]);
  });
});

describe("readTrace: other languages", () => {
  it("reads Python's chained tracebacks, the raised one first, frames innermost first", () => {
    const trace = read(fixture("python-chain.txt"));
    expect(trace.language).toBe("python");
    expect(trace.reversed).toBe(true);
    expect(outline(trace).map((line) => line.replace(/\/Applications\/\S+\/lib\/python3\.9\//, "<stdlib>/"))).toEqual([
      "top 0 FileNotFoundError: [Errno 2] No such file or directory: 'deploy.defaults.json'",
      "  read_settings data/traces/py/settings.py:10 app",
      "  main data/traces/py/deploy.py:12 app",
      "  <module> data/traces/py/deploy.py:17 app",
      "context 0 settings.SettingsError: data/traces/py/deploy.json is not valid JSON",
      "  read_settings data/traces/py/settings.py:15 app",
      "  main data/traces/py/deploy.py:10 app",
      "cause 0 json.decoder.JSONDecodeError: Expecting property name enclosed in double quotes: line 4 column 3 (char 45)",
      "  raw_decode <stdlib>/json/decoder.py:353 lib",
      "  decode <stdlib>/json/decoder.py:337 lib",
      "  loads <stdlib>/json/__init__.py:346 lib",
      "  read_settings data/traces/py/settings.py:13 app",
    ]);
    expect(trace.sections[0].frames[0].source).toBe("with open(path) as handle:");
    expect(relationLabel("context", null)).toBe("While handling");
  });

  it("reads Python 3.11+ caret lines and a SyntaxError without a function", () => {
    const trace = read(`Traceback (most recent call last):
  File "/app/run.py", line 4, in <module>
    total = add(1, "2")
            ^^^^^^^^^^^
  File "/app/run.py", line 2, in add
    return a + b
           ~~^~~
TypeError: unsupported operand type(s) for +: 'int' and 'str'`);
    expect(trace.sections[0].frames.map((f) => [f.fn, f.source])).toEqual([
      ["add", "return a + b"],
      ["<module>", 'total = add(1, "2")'],
    ]);
  });

  it("reads a Go panic's first goroutine, runtime and std frames as library", () => {
    const trace = read(fixture("go-panic.txt"));
    expect(trace.notes).toEqual(["goroutine 1 [running]", "exit status 2"]);
    expect(outline(trace).map((line) => line.replace(/\/opt\/homebrew\/Cellar\/go\/[\d.]+\/libexec\/src\//, "<goroot>/"))).toEqual([
      "top 0 panic: runtime error: index out of range [2] with length 2",
      "  main.newest.func1 data/traces/go/main.go:16 app",
      "  sort.insertionSort_func <goroot>/sort/zsortfunc.go:12 lib",
      "  sort.pdqsort_func <goroot>/sort/zsortfunc.go:73 lib",
      "  sort.Slice <goroot>/sort/slice.go:29 lib",
      "  main.newest data/traces/go/main.go:15 app",
      "  main.main data/traces/go/main.go:26 app",
    ]);
  });

  it("reads a Rust panic with RUST_BACKTRACE=1, and one without a backtrace", () => {
    const trace = read(fixture("rust-panic.txt"));
    expect(trace.notes).toEqual(["thread 'main'"]);
    const lines = outline(trace);
    expect(lines[0]).toBe("top 0 panic: WORKERS must be a whole number: ParseIntError { kind: InvalidDigit }");
    expect(lines.filter((line) => line.endsWith(" app"))).toEqual([
      "  main::workers ./data/traces/rust/main.rs:6 app",
      "  main::main ./data/traces/rust/main.rs:10 app",
    ]);
    expect(trace.sections[0].frames).toHaveLength(7);

    const bare = read("thread 'main' panicked at src/main.rs:4:5:\nindex out of bounds: the len is 3 but the index is 5\nnote: run with `RUST_BACKTRACE=1` environment variable to display a backtrace");
    expect(outline(bare)).toEqual(["top 0 panic: index out of bounds: the len is 3 but the index is 5", "  - src/main.rs:4 app"]);
    expect(bare.notes).toEqual(["thread 'main'", "run with `RUST_BACKTRACE=1` environment variable to display a backtrace"]);
  });

  it("reads Java's Caused by and ... N more, frameworks as library frames", () => {
    const trace = read(fixture("java-caused-by.txt"));
    expect(trace.notes).toEqual(['thread "main"']);
    expect(outline(trace)).toEqual([
      "top 0 java.lang.IllegalStateException: Failed to load order 1042",
      "  com.acme.orders.OrderService.load OrderService.java:48 app",
      "  com.acme.orders.OrderController.show OrderController.java:31 app",
      "  java.base/jdk.internal.reflect.DirectMethodHandleAccessor.invoke DirectMethodHandleAccessor.java:103 lib",
      "  java.base/java.lang.reflect.Method.invoke Method.java:580 lib",
      "  org.springframework.web.method.support.InvocableHandlerMethod.doInvoke InvocableHandlerMethod.java:255 lib",
      "  org.springframework.web.servlet.DispatcherServlet.doDispatch DispatcherServlet.java:1089 lib",
      "  com.acme.orders.Application.main Application.java:12 app",
      "cause 0 java.sql.SQLTimeoutException: Statement cancelled due to timeout or client request",
      "  org.postgresql.jdbc.PgStatement.executeInternal PgStatement.java:497 lib",
      "  org.postgresql.jdbc.PgPreparedStatement.executeQuery PgPreparedStatement.java:134 lib",
      "  com.zaxxer.hikari.pool.HikariProxyPreparedStatement.executeQuery - lib",
      "  com.acme.orders.OrderRepository.findById OrderRepository.java:77 app",
      "  com.acme.orders.OrderService.load OrderService.java:44 app",
    ]);
    expect(trace.sections[1].omitted).toBe(6);
    // A JVM frame names only its file: the code is looked for where Maven and Gradle keep the package.
    expect(sourcePath(trace.sections[0].frames[0])).toBe("src/main/java/com/acme/orders/OrderService.java");
  });

  it("reads .NET inner exceptions", () => {
    // The shape of Exception.ToString() (docs.microsoft.com, "Exception.ToString"); no dotnet SDK here.
    const trace = read(`Unhandled exception. System.InvalidOperationException: Couldn't load the cart
 ---> System.IO.FileNotFoundException: Could not find file '/srv/cart.json'.
   at System.IO.FileStream.ValidateFileHandle(SafeFileHandle fileHandle)
   at Shop.CartStore.Load(String path) in /src/Shop/CartStore.cs:line 18
   --- End of inner exception stack trace ---
   at Shop.CartStore.Load(String path) in /src/Shop/CartStore.cs:line 22
   at Program.<Main>$(String[] args) in /src/Shop/Program.cs:line 5`);
    expect(outline(trace)).toEqual([
      "top 0 System.InvalidOperationException: Couldn't load the cart",
      "  Shop.CartStore.Load(String path) /src/Shop/CartStore.cs:22 app",
      "  Program.<Main>$(String[] args) /src/Shop/Program.cs:5 app",
      "cause 0 System.IO.FileNotFoundException: Could not find file '/srv/cart.json'.",
      "  System.IO.FileStream.ValidateFileHandle(SafeFileHandle fileHandle) - lib",
      "  Shop.CartStore.Load(String path) /src/Shop/CartStore.cs:18 app",
    ]);
  });

  it("reads Ruby's backtrace and Swift's fatal error", () => {
    // ruby 2.6 and swiftc 6.3 on this machine.
    const ruby = read("/tmp/genui-r.rb:2:in `/': divided by 0 (ZeroDivisionError)\n\tfrom /tmp/genui-r.rb:2:in `average'\n\tfrom /tmp/genui-r.rb:4:in `<main>'");
    expect(outline(ruby)).toEqual([
      "top 0 ZeroDivisionError: divided by 0",
      "  / /tmp/genui-r.rb:2 app",
      "  average /tmp/genui-r.rb:2 app",
      "  <main> /tmp/genui-r.rb:4 app",
    ]);
    const swift = read("Swift/ContiguousArrayBuffer.swift:692: Fatal error: Index out of range");
    expect(outline(swift)).toEqual(["top 0 Fatal error: Index out of range", "  - Swift/ContiguousArrayBuffer.swift:692 lib"]);
  });
});

describe("readTrace: edges", () => {
  it("refuses what is no trace and reads a bare message", () => {
    expect(readTrace(42)).toMatchObject({ ok: false });
    expect(readTrace("  \n")).toMatchObject({ ok: false, error: "The trace is empty" });
    expect(readTrace({ kind: "x" } as Value)).toMatchObject({ ok: false });
    expect(outline(read("Something went wrong: the disk is full"))).toEqual(["top 0 : Something went wrong: the disk is full"]);
    expect(outline(read(["TypeError: x is not a function", "    at run (/r/a.js:1:2)"]))).toEqual(["top 0 TypeError: x is not a function", "  run /r/a.js:1 app"]);
  });

  it("splits a header into type and message only when it names a type", () => {
    expect(splitHeader("TypeError [ERR_INVALID_ARG_TYPE]: bad")).toEqual({ type: "TypeError [ERR_INVALID_ARG_TYPE]", message: "bad" });
    expect(splitHeader("KeyboardInterrupt")).toEqual({ type: "KeyboardInterrupt", message: "" });
    expect(splitHeader("Deploy: done")).toEqual({ type: "Deploy", message: "done" });
    expect(splitHeader("it broke: badly")).toEqual({ type: "", message: "it broke: badly" });
  });

  it("reads a huge trace and folds runs of library frames", () => {
    const frames = Array.from({ length: 5000 }, (_, index) => `    at f${index} (/repo/${index % 10 < 7 ? "node_modules/lib" : "src"}/a.js:${index + 1}:1)`);
    const trace = read(`RangeError: Maximum call stack size exceeded\n${frames.join("\n")}`);
    expect(trace.sections[0].frames).toHaveLength(5000);
    const rows = frameRows(trace.sections[0].frames, new Set());
    expect(rows.slice(0, 2)).toEqual([
      { type: "fold", start: 0, count: 7 },
      { type: "frame", index: 7 },
    ]);
    expect(frameRows(trace.sections[0].frames, new Set([0])).slice(0, 2)).toEqual([
      { type: "frame", index: 0 },
      { type: "frame", index: 1 },
    ]);
  });
});

describe("stackFrame: browser, Ruby and Rust library paths", () => {
  it("reads served URLs as app paths and knows more runtimes' libraries", () => {
    const frame = (line: string) => {
      const read = stackFrame(line);
      return read === null ? null : [read.path, read.line, read.column, read.app];
    };
    expect(frame("fn@http://localhost:3000/static/js/main.js:10:5")).toEqual(["static/js/main.js", 10, 5, true]);
    expect(frame("    at App (webpack-internal:///./src/App.tsx:12:5)")).toEqual(["./src/App.tsx", 12, 5, true]);
    expect(frame("render@/Users/me/app/src/view.js:3:7")).toEqual(["/Users/me/app/src/view.js", 3, 7, true]);
    expect(frame("\tfrom /usr/lib/ruby/2.6.0/json.rb:9:in `parse'")?.[3]).toBe(false);
    expect(frame("\tfrom /app/vendor/bundle/ruby/3.3.0/gems/rack-3.0/lib/rack.rb:9:in `call'")?.[3]).toBe(false);
    expect(frame("             at /opt/homebrew/Cellar/rust/1.98.1/lib/rustlib/src/rust/library/core/src/result.rs:1183:23")?.[3]).toBe(false);
    expect(frame("see http://example.com/a.js:1:2 for details")).toBeNull();
  });
});
