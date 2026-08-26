import { createServer, type IncomingMessage, type Server } from "node:http";
import { githubWebhookPath } from "./github-webhook.ts";

export interface WebhookHttpResult {
  status: number;
  body: unknown;
}

export type WebhookRequestHandler = (input: {
  raw: string;
  event: string;
  signature: string | undefined;
}) => Promise<WebhookHttpResult>;

const MAX_BODY_BYTES = 5 * 1024 * 1024;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error("payload too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

export async function startWebhookListener(args: {
  handle: WebhookRequestHandler;
  signal?: AbortSignal;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const path = githubWebhookPath();
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== path) {
        sendJson(res, 404, { ok: false, error: "not found" });
        return;
      }
      if (req.method === "GET") {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, { ok: false, error: "method not allowed" });
        return;
      }
      let raw: string;
      try {
        raw = await readBody(req, MAX_BODY_BYTES);
      } catch {
        sendJson(res, 413, { ok: false, error: "payload too large" });
        return;
      }
      const result = await args.handle({
        raw,
        event: header(req, "x-github-event") ?? "",
        signature: header(req, "x-hub-signature-256"),
      });
      sendJson(res, result.status, result.body);
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal error" });
      else res.end();
    });
  });

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });

  if (args.signal !== undefined) {
    if (args.signal.aborted) {
      server.close();
      throw new Error("aborted");
    }
    args.signal.addEventListener(
      "abort",
      () => {
        server.close();
      },
      { once: true },
    );
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("webhook listener failed to bind"));
        return;
      }
      resolve(address.port);
    });
  });

  return { port, close };
}
