// The plugin's one way onto the network: GET over https to public addresses
// only. Every hop of a redirect is checked again, and the address check runs
// inside the connection's own DNS lookup, so the address that was checked is
// the address connected to (no DNS-rebinding window). Bodies are capped and
// requests time out; failures are values with a short reason, never throws.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import type { IncomingHttpHeaders } from "node:http";
import { Agent, request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { isPublicAddress } from "./address";

/** Names this plugin to every service, as their usage policies require. */
export const USER_AGENT = "bb-plugin-genui/0.1 (Generative UI plugin for bb; https://getbb.app)";

const MAX_REDIRECTS = 5;
/** A connection that goes quiet this long is dropped, whatever the overall deadline. */
const IDLE_MS = 8_000;

export interface GetOptions {
  /** The Accept header. */
  readonly accept: string;
  readonly maxBytes: number;
  /** Deadline for the whole request, redirects included. */
  readonly timeoutMs: number;
  /** Extra request headers (conditional-request validators). */
  readonly headers?: Readonly<Record<string, string>>;
}

export type Fetched =
  | {
      readonly ok: true;
      /** 200, or 304 when validators were sent and still hold (empty body). */
      readonly status: 200 | 304;
      /** The final URL after redirects. */
      readonly url: string;
      readonly headers: IncomingHttpHeaders;
      readonly body: Buffer;
    }
  /** `status`: the HTTP status, when the server answered with an error one (a 404 is a real "no such page"). */
  | { readonly ok: false; readonly error: string; readonly status?: number };

/** A response body as JSON; undefined when it isn't. */
export function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

class Refused extends Error {}

/** Resolves like dns.lookup, but fails unless every address is public. */
const publicLookup = ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses: LookupAddress[]) => {
    if (error) {
      callback(error);
      return;
    }
    if (addresses.length === 0 || addresses.some((entry) => !isPublicAddress(entry.address))) {
      callback(new Refused(`${hostname} is not on the public internet`));
      return;
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}) as unknown as LookupFunction;

const agent = new Agent({ keepAlive: true, maxSockets: 6, lookup: publicLookup });

/** Why `url` may not be fetched, or null when it may. */
export function refusal(url: URL): string | null {
  if (url.protocol !== "https:") return "only https links can be fetched";
  if (url.username !== "" || url.password !== "") return "links with credentials can't be fetched";
  if (url.port !== "") return "only the standard https port is allowed";
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (host === "") return "the link has no host";
  if (isIP(host) !== 0 && !isPublicAddress(host)) return `${host} is not on the public internet`;
  return null;
}

type Hop =
  | { readonly kind: "redirect"; readonly location: string | undefined }
  | { readonly kind: "done"; readonly status: 200 | 304; readonly headers: IncomingHttpHeaders; readonly body: Buffer }
  | { readonly kind: "failed"; readonly error: string; readonly status?: number };

function failure(cause: unknown, deadline: AbortSignal): string {
  if (deadline.aborted) return "the request timed out";
  if (cause instanceof Refused) return cause.message;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "the host could not be found";
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") return "the host could not be reached";
  if (code.startsWith("ERR_TLS") || code.includes("CERT")) return "the host's certificate was not accepted";
  return cause instanceof Error ? cause.message : String(cause);
}

/** Undoes a Content-Encoding a server applied despite `Accept-Encoding: identity`, within the size cap. */
function decode(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const options = { maxOutputLength: maxBytes };
  switch ((encoding ?? "identity").trim().toLowerCase()) {
    case "identity":
    case "":
      return body;
    case "gzip":
    case "x-gzip":
      return gunzipSync(body, options);
    case "deflate":
      return inflateSync(body, options);
    case "br":
      return brotliDecompressSync(body, options);
    default:
      throw new Error(`unsupported content encoding ${encoding}`);
  }
}

function hop(url: URL, options: GetOptions, deadline: AbortSignal): Promise<Hop> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: Hop) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    const req = request(
      url,
      {
        method: "GET",
        agent,
        lookup: publicLookup,
        signal: deadline,
        timeout: IDLE_MS,
        headers: {
          "user-agent": USER_AGENT,
          accept: options.accept,
          "accept-encoding": "identity",
          ...options.headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && status !== 304) {
          res.resume();
          settle({ kind: "redirect", location: res.headers.location });
          return;
        }
        if (status !== 200 && status !== 304) {
          res.resume();
          settle({ kind: "failed", error: `the server answered ${status}`, status });
          return;
        }
        const declared = Number(res.headers["content-length"]);
        const tooLarge = `the response is over the ${Math.round(options.maxBytes / 1024 / 1024)} MB limit`;
        if (Number.isFinite(declared) && declared > options.maxBytes) {
          res.destroy();
          settle({ kind: "failed", error: tooLarge });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            res.destroy();
            settle({ kind: "failed", error: tooLarge });
          } else {
            chunks.push(chunk);
          }
        });
        res.on("end", () => {
          try {
            const body = decode(Buffer.concat(chunks), res.headers["content-encoding"], options.maxBytes);
            settle({ kind: "done", status: status === 304 ? 304 : 200, headers: res.headers, body });
          } catch (cause) {
            settle({ kind: "failed", error: failure(cause, deadline) });
          }
        });
        res.on("error", (cause) => settle({ kind: "failed", error: failure(cause, deadline) }));
        res.on("close", () => settle({ kind: "failed", error: "the connection closed early" }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("the host stopped responding")));
    req.on("error", (cause) => settle({ kind: "failed", error: failure(cause, deadline) }));
    req.end();
  });
}

/** GETs `input` under the rules above. */
export async function safeGet(input: string, options: GetOptions): Promise<Fetched> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, error: "the link is not a valid URL" };
  }
  const deadline = AbortSignal.timeout(options.timeoutMs);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const refused = refusal(url);
    if (refused !== null) return { ok: false, error: refused };
    const result = await hop(url, options, deadline);
    if (result.kind === "failed") return { ok: false, error: result.error, ...(result.status === undefined ? {} : { status: result.status }) };
    if (result.kind === "done") {
      return { ok: true, status: result.status, url: url.href, headers: result.headers, body: result.body };
    }
    if (result.location === undefined) return { ok: false, error: "a redirect had no destination" };
    try {
      url = new URL(result.location, url);
    } catch {
      return { ok: false, error: "a redirect pointed at an invalid URL" };
    }
  }
  return { ok: false, error: "too many redirects" };
}
