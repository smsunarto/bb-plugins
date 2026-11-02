import { z } from "zod";
import type { ContentMode } from "./turn-trace.ts";

export const DEFAULT_INGEST_URL = "https://ingest.neatlogs.com";

const ingestUrl = z.string().refine((value) => parseIngestUrl(value) !== null, {
  message: "Use an http(s) origin without a path, such as https://ingest.neatlogs.com.",
});

export const NEATLOGS_SETTINGS = {
  apiKey: {
    type: "string" as const,
    label: "Neatlogs project API key",
    secret: true as const,
  },
  ingestUrl: {
    type: "string" as const,
    label: "Ingest URL (https://eu.ingest.neatlogs.com for EU projects)",
    default: DEFAULT_INGEST_URL,
    experimental_schema: ingestUrl,
  },
  contentMode: {
    type: "select" as const,
    label: "Trace content",
    options: ["full", "metadata"],
    experimental_optionLabels: {
      full: "Prompts, replies, and tool input/output",
      metadata: "Timing, status, models, and tokens only",
    },
    default: "full",
  },
};

export interface NeatlogsConfig {
  apiKey: string;
  /** The `/v1/trace` endpoint on the configured ingest origin. */
  traceUrl: string;
  contentMode: ContentMode;
}

function parseIngestUrl(value: string): URL | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const extra = url.username + url.password + url.search + url.hash;
    if (extra !== "" || url.pathname !== "/") return null;
    return url;
  } catch {
    return null;
  }
}

/** Null until an API key is set; the settings schema already rejects a bad URL. */
export function parseNeatlogsSettings(values: {
  apiKey?: string | number | boolean;
  ingestUrl: string;
  contentMode: string;
}): NeatlogsConfig | null {
  const apiKey = typeof values.apiKey === "string" ? values.apiKey.trim() : "";
  const origin = parseIngestUrl(values.ingestUrl) ?? new URL(DEFAULT_INGEST_URL);
  if (apiKey === "") return null;
  return {
    apiKey,
    traceUrl: new URL("/v1/trace", origin).toString(),
    contentMode: values.contentMode === "metadata" ? "metadata" : "full",
  };
}
