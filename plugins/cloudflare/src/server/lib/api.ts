import { z } from "zod";

const envelope = z.object({
  success: z.boolean(),
  result: z.unknown().optional(),
  result_info: z
    .object({
      total_pages: z.number().optional(),
      total_count: z.number().optional(),
      count: z.number().optional(),
    })
    .optional(),
});
export class CloudflareError extends Error {
  readonly uncertain: boolean;
  readonly status: number;
  constructor(message: string, status = 0, uncertain = false) {
    super(message);
    this.name = "CloudflareError";
    this.status = status;
    this.uncertain = uncertain;
  }
}
export class CloudflareAPI {
  readonly token: string;
  readonly fetcher: typeof fetch;
  constructor(token: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.fetcher = fetcher;
  }
  async request<T>(method: string, path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const answer = await this.envelope(method, path, body);
    const parsed = schema.safeParse(answer.result);
    if (!parsed.success)
      throw new CloudflareError(
        "Cloudflare returned an unexpected response. Refresh inventory before retrying.",
        0,
        method !== "GET",
      );
    return parsed.data;
  }
  private async envelope(method: string, path: string, body?: unknown) {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      });
    } catch {
      throw new CloudflareError(
        "Cloudflare could not be reached. A write may have completed. Retry to inspect its saved resource identity.",
        0,
        method !== "GET",
      );
    }
    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? "Cloudflare denied this operation. Check token permissions and account scope."
          : response.status === 429
            ? "Cloudflare rate limit reached. Retry later."
            : `Cloudflare request failed (HTTP ${response.status}).`;
      throw new CloudflareError(
        message,
        response.status,
        method !== "GET" && response.status >= 500,
      );
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new CloudflareError("Cloudflare returned invalid JSON.", 0, method !== "GET");
    }
    const parsed = envelope.safeParse(raw);
    if (!parsed.success)
      throw new CloudflareError(
        "Cloudflare returned an invalid response envelope.",
        0,
        method !== "GET",
      );
    if (!parsed.data.success)
      throw new CloudflareError(
        "Cloudflare rejected the operation. Check token permissions and resource configuration.",
      );
    return parsed.data;
  }
  async list<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 50; page++) {
      const answer = await this.envelope(
        "GET",
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&per_page=100`,
      );
      const parsed = z.array(schema).safeParse(answer.result);
      if (!parsed.success)
        throw new CloudflareError("Cloudflare returned an invalid inventory response.");
      items.push(...parsed.data);
      const info = answer.result_info;
      if (
        info?.total_pages !== undefined
          ? page >= info.total_pages
          : info?.total_count !== undefined
            ? items.length >= info.total_count
            : parsed.data.length < 100
      )
        return items;
    }
    throw new CloudflareError(
      "Cloudflare inventory exceeds 5,000 resources. Narrow the API token account scope.",
    );
  }
}
export const tunnelSchema = z.object({
  id: z.string(),
  name: z.string(),
  config_src: z.string().optional(),
  status: z.string().optional(),
});
export const connectionSchema = z.object({
  id: z.string(),
  conns: z.array(z.object({ client_id: z.string().optional() })).default([]),
});
export const policySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    decision: z.string(),
    include: z.array(z.unknown()).default([]),
    exclude: z.array(z.unknown()).default([]),
    require: z.array(z.unknown()).default([]),
  })
  .passthrough();
export const appSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    domain: z.string().optional(),
    self_hosted_domains: z.array(z.string()).optional(),
    destinations: z
      .array(z.object({ type: z.string().optional(), uri: z.string().optional() }))
      .optional(),
    aud: z.string().optional(),
    allowed_idps: z.array(z.string()).optional(),
    policies: z.array(z.object({ id: z.string() })).default([]),
  })
  .passthrough();
export const dnsSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
  ttl: z.number().int().nonnegative().optional(),
  comment: z.string().nullish(),
});
export const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  account: z.object({ id: z.string() }),
});
export const idpSchema = z.object({ id: z.string(), name: z.string(), type: z.string() });
export const configSchema = z.object({
  config: z.record(z.string(), z.unknown()).nullable().optional(),
});
export const ingressConfigSchema = z.object({
  config: z
    .object({
      ingress: z
        .array(z.object({ hostname: z.string().optional(), service: z.string() }))
        .default([]),
    })
    .nullable()
    .optional(),
});
export type App = z.infer<typeof appSchema>;
export type Policy = z.infer<typeof policySchema>;
export function policyEmails(policy: Policy): string[] {
  return policy.include.flatMap((value) => {
    const item = z.object({ email: z.object({ email: z.string() }) }).safeParse(value);
    return item.success ? [item.data.email.email] : [];
  });
}
export function appOverlaps(app: App, hostname: string): boolean {
  return [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations?.filter((d) => d.type === "public" || !d.type).map((d) => d.uri) ?? []),
  ].some((value) => {
    if (!value) return false;
    const host = value
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      ?.split(":")[0]
      ?.toLowerCase();
    if (!host) return false;
    const pattern = host
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${pattern}$`).test(hostname);
  });
}
