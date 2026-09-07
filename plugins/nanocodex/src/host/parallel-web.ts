import type { NamedTool } from "nanocodex/host";
import Parallel from "parallel-web";
import { z } from "zod";

const PARALLEL_TOOL_TIMEOUT_MS = 45_000;
const PARALLEL_SEARCH_TIMEOUT_MS = 30_000;
const MAX_ERROR_CHARACTERS = 4_000;

const responseLengthSchema = z.enum(["short", "medium", "long"]);
const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1),
    domains: z.array(z.string().trim().min(1)).max(20).optional(),
    recency: z.number().int().positive().max(3_650).optional(),
  })
  .strict();
const parallelWebInputSchema = z
  .object({
    search_query: z.array(searchQuerySchema).min(1).max(4),
    response_length: responseLengthSchema.default("medium"),
  })
  .strict();

const responseLengths = {
  short: { maxResults: 5, excerptCharacters: 12_000 },
  medium: { maxResults: 10, excerptCharacters: 30_000 },
  long: { maxResults: 10, excerptCharacters: 60_000 },
} satisfies Record<
  z.infer<typeof responseLengthSchema>,
  {
    readonly maxResults: number;
    readonly excerptCharacters: number;
  }
>;

export type ParallelSearch = (
  request: Parallel.SearchParams,
  options: Parallel.RequestOptions,
) => Promise<Parallel.SearchResult>;

export interface ParallelWebDependencies {
  readonly search?: ParallelSearch;
  readonly now?: () => Date;
}

export function createParallelWebTool(dependencies: ParallelWebDependencies = {}): NamedTool {
  const search = dependencies.search ?? createSdkSearch();
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    name: "web__run",
    description: [
      "Search the public web with Parallel Search.",
      "Use search_query for current or externally sourced facts and return direct source URLs in the answer.",
      "Send at most four queries per call. domains limits a query to specific domains, and recency limits results to the last N days.",
    ].join("\n\n"),
    parameters: z.toJSONSchema(parallelWebInputSchema),
    outputSchema: { type: "string" },
    async handler(input, context) {
      const request = parallelWebInputSchema.parse(input);
      const profile = responseLengths[request.response_length];
      const timeout = AbortSignal.timeout(PARALLEL_TOOL_TIMEOUT_MS);
      const signal = AbortSignal.any([context.signal, timeout]);
      const searches: Array<{ readonly q: string; readonly result: unknown }> = [];

      for (const query of request.search_query) {
        try {
          const result = await search(
            buildParallelSearchRequest({
              search: query,
              sessionId: context.sessionId,
              profile,
              now: now(),
            }),
            {
              signal,
              timeout: PARALLEL_SEARCH_TIMEOUT_MS,
              maxRetries: 0,
            },
          );
          searches.push({ q: query.q, result });
        } catch (error) {
          if (context.signal.aborted) context.signal.throwIfAborted();
          if (timeout.aborted) {
            throw new Error(
              `Parallel web search timed out after ${PARALLEL_TOOL_TIMEOUT_MS / 1_000} seconds`,
              { cause: error },
            );
          }
          throw new Error(
            `Parallel web search failed for ${JSON.stringify(query.q)}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      }

      return JSON.stringify({ search_query: searches }, null, 2);
    },
  } satisfies NamedTool);
}

function createSdkSearch(): ParallelSearch {
  let client: Parallel | undefined;
  return (request, options) => {
    client ??= new Parallel({
      timeout: PARALLEL_SEARCH_TIMEOUT_MS,
      maxRetries: 0,
    });
    return client.search(request, options);
  };
}

function buildParallelSearchRequest(args: {
  readonly search: z.infer<typeof searchQuerySchema>;
  readonly sessionId: string;
  readonly profile: { readonly maxResults: number; readonly excerptCharacters: number };
  readonly now: Date;
}): Parallel.SearchParams {
  const includeDomains = args.search.domains;
  const afterDate =
    args.search.recency === undefined ? undefined : daysBefore(args.now, args.search.recency);
  const sourcePolicy =
    includeDomains === undefined && afterDate === undefined
      ? undefined
      : ({
          ...(includeDomains === undefined ? {} : { include_domains: includeDomains }),
          ...(afterDate === undefined ? {} : { after_date: afterDate }),
        } satisfies Parallel.SourcePolicy);

  return {
    search_queries: [args.search.q],
    mode: "fast",
    max_chars_total: args.profile.excerptCharacters,
    session_id: args.sessionId,
    advanced_settings: {
      max_results: args.profile.maxResults,
      ...(sourcePolicy === undefined ? {} : { source_policy: sourcePolicy }),
    },
  };
}

function daysBefore(now: Date, days: number): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("PARALLEL_API_KEY")) {
    return "PARALLEL_API_KEY is missing from the NanoCodex host environment";
  }
  return boundedError(message);
}

function boundedError(message: string): string {
  return message.length <= MAX_ERROR_CHARACTERS
    ? message
    : `${message.slice(0, MAX_ERROR_CHARACTERS)}…`;
}
