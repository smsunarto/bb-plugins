// Serve a static export over loopback for browser validation.
//
// Run with Bun:
//   bun run <skill-directory>/scripts/serve-static.ts --directory .pr-walkthrough/site/out
//
// Defaults bind 127.0.0.1:4173. Never bind 0.0.0.0 for a full-context artifact.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

const CONTENT_TYPES = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/vnd.microsoft.icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webp", "image/webp"],
  [".woff2", "font/woff2"],
]);

const USAGE = `usage: serve-static.ts [-h] [--directory DIRECTORY] [--port PORT] [--bind HOST]

Serve a static export over loopback for browser validation.
`;

function usageError(message: string): never {
  process.stderr.write(USAGE);
  process.stderr.write(`serve-static.ts: error: ${message}\n`);
  process.exit(2);
}

function parseCliArgs(argv: string[], optionNames: string[]): Map<string, string> {
  const values = new Map<string, string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (token === "-h" || token === "--help") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(0, equals) : token;
    if (optionNames.includes(name)) {
      if (equals >= 0) {
        values.set(name, token.slice(equals + 1));
        index += 1;
        continue;
      }
      const value: string | undefined = argv[index + 1];
      if (value === undefined) usageError(`argument ${name}: expected one argument`);
      values.set(name, value);
      index += 2;
      continue;
    }
    usageError(`unrecognized arguments: ${token}`);
  }
  return values;
}

function resolveTarget(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  } catch {
    return null;
  }
  const candidate = path.resolve(root, `.${decoded}`);
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    if (fs.statSync(candidate).isDirectory()) {
      const index = path.join(candidate, "index.html");
      return fs.statSync(index).isFile() ? index : null;
    }
    return candidate;
  } catch {
    return null;
  }
}

const options = parseCliArgs(process.argv.slice(2), ["--directory", "--port", "--bind"]);
const root = path.resolve(options.get("--directory") ?? ".");
const port = Number(options.get("--port") ?? "4173");
const host = options.get("--bind") ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535) usageError("--port must be a TCP port");

const server = http.createServer((request, response) => {
  const target = resolveTarget(root, request.url ?? "/");
  if (target === null) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("404 Not Found\n");
    return;
  }
  let body: Buffer;
  try {
    body = fs.readFileSync(target);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("404 Not Found\n");
    return;
  }
  response.writeHead(200, {
    "content-type":
      CONTENT_TYPES.get(path.extname(target).toLowerCase()) ?? "application/octet-stream",
    "content-length": String(body.length),
  });
  response.end(body);
});

server.listen(port, host, () => {
  process.stdout.write(`Serving ${root} on http://${host}:${String(port)}/\n`);
});
