import { parseReasoningLevel, DEFAULT_REASONING_LEVELS, REASONING_LEVELS } from "./lib/reasoning";

// Magic Compose: route a new-thread prompt to a project, machine, model, and
// reasoning level with Jev (TypeSafe's classifier) on the Vercel AI Gateway,
// then start the thread there. app.tsx owns the composer toggle; this file
// gathers the candidates, asks Jev, and spawns.
import { makePluginRuntime, type PluginRuntime } from "@bb-plugins/effect-bridge";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
  type PluginCliPositional,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import { Cause, Context, Data, Effect, Exit, Fiber, FiberSet, Layer } from "effect";
import { z } from "zod";
import { hostContract, machineStatsSchema } from "./contract";
import {
  askChoicesVia,
  JEV_PROVIDERS,
  JevError,
  warmRoutes,
  type JevProvider,
  type JevRoute,
} from "./lib/jev";
import { JevTransport } from "./lib/transport";
import { makeSwrCache, type SwrCache } from "./lib/cache";
import {
  backtestRows,
  parseMapping,
  score,
  tally,
  type BacktestResult,
  type HistoryRow,
} from "./lib/history";
import { formatSpans, Profiler } from "./lib/profile";
import {
  DEFAULT_PREFERENCES,
  PERMISSION_MODES,
  type Preferences,
  preferencesPatchSchema,
  preferencesSchema,
  readStoredPreferences,
} from "./lib/preferences";
import {
  describeMachine,
  route,
  RouteError,
  type MachineCandidate,
  type MachineStats,
  type ModelCandidate,
  type Pick,
  type ProjectCandidate,
  type ReasoningCandidate,
  type RotationEntry,
  type RouteDecision,
  type Targets,
} from "./lib/router";

const ROTATION_KEY = "rotation";
const SCOPE_KEY = "scope";
const PREFERENCES_KEY = "preferences";
const MAX_ROTATION_ENTRIES = 24;
const RECENT_TITLES_PER_PROJECT = 4;
const STATS_TIMEOUT_MS = 2_500;
const STATS_FRESH_MS = 15_000;
/** Which machines hold a project, and what each can create, rarely change. */
const AVAILABILITY_FRESH_MS = 30_000;
/** How old a cached fact may be and still be served while a refresh runs behind it. */
const SERVE_STALE_MS = 10 * 60_000;
/**
 * How long a dispatch waits for a machine to describe itself when nothing is
 * cached, as just after BB starts. Past this it routes without that detail;
 * the answer still lands in the cache for next time.
 */
const FACT_WAIT_MS = 350;
const PROVIDER_CHECK_TIMEOUT_MS = 2_500;
/**
 * How long loading a project's environments or a provider's models may take.
 * A dispatch waits only PROVIDER_CHECK_TIMEOUT_MS for them, but the load goes
 * on and caches the answer for the next one. One still running once its
 * answer would no longer be fresh has likely hung, so it gives way to a retry.
 */
const AVAILABILITY_LOAD_TIMEOUT_MS = AVAILABILITY_FRESH_MS;
/** A fresh worktree per thread, unless the user picks otherwise. */
const DEFAULT_ENVIRONMENTS = ["git-worktree"];
/** Works for any project with a folder, so it backs up environments that need git. */
const FALLBACK_ENVIRONMENT = "project-checkout";
/** `auto` uses whichever key is set, and both when both are: the second backs up the first. */
const JEV_PROVIDER_CHOICES = ["auto", "vercel", "openrouter"] as const;

type PermissionMode = (typeof PERMISSION_MODES)[number];

const rotationEntrySchema = z
  .object({
    providerId: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    note: z.string().max(600),
    reasoningLevel: z.enum(REASONING_LEVELS),
  })
  .strict();
const rotationSchema = z.array(rotationEntrySchema).max(MAX_ROTATION_ENTRIES);

// Which projects, environments, and effort levels Magic Compose may choose between.
const scopeSchema = z
  .object({
    /** True offers every project, including ones added later and "No project". */
    allProjects: z.boolean(),
    /** Offered when `allProjects` is false. The personal project's id means "No project". */
    projectIds: z.array(z.string().min(1).max(200)).max(1_000),
    /** Environment provider ids, in order of preference. */
    environmentIds: z.array(z.string().min(1).max(64)).max(32),
    /** Effort levels Magic Compose may pick. */
    reasoningLevels: z.array(z.enum(REASONING_LEVELS)),
  })
  .strict();
type Scope = z.infer<typeof scopeSchema>;
// No field here may carry a default: a default would be filled in for every
// field a partial save leaves out, and overwrite what the user had chosen.
const scopePatchSchema = scopeSchema.partial();
// Scopes saved before effort levels existed lack the field.
const storedScopeSchema = scopeSchema.extend({
  reasoningLevels: scopeSchema.shape.reasoningLevels.optional(),
});
const DEFAULT_SCOPE: Scope = {
  allProjects: true,
  projectIds: [],
  environmentIds: DEFAULT_ENVIRONMENTS,
  reasoningLevels: [...DEFAULT_REASONING_LEVELS],
};

const pickSchema = z
  .object({
    label: z.string(),
    source: z.enum(["jev", "only-option", "fallback"]),
    probability: z.number().nullable(),
    confidence: z.number().nullable(),
    alternatives: z.array(z.object({ label: z.string(), probability: z.number() }).strict()),
  })
  .strict();

const decisionSchema = z
  .object({
    project: pickSchema.extend({ id: z.string() }),
    machine: pickSchema.extend({ id: z.string() }),
    model: pickSchema.extend({ providerId: z.string(), model: z.string() }),
    reasoning: pickSchema,
    environment: pickSchema.extend({ id: z.string() }),
    latencyMs: z.number(),
    /** Where the time went; overlapping spans ran in parallel. */
    timings: z.array(
      z.object({ name: z.string(), startMs: z.number(), endMs: z.number() }).strict(),
    ),
  })
  .strict();
export type DecisionSummary = z.infer<typeof decisionSchema>;

const promptSchema = z.string().trim().min(1).max(200_000);

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z
      .object({
        hasApiKey: z.boolean(),
        rotationSize: z.number(),
        /** The gateways a question goes to, in the order they are tried. */
        gateways: z.array(z.string()),
        /** The last time Jev was asked, since the plugin loaded. */
        last: z
          .object({
            at: z.number(),
            latencyMs: z.number().nullable(),
            error: z.string().nullable(),
          })
          .strict()
          .nullable(),
      })
      .strict(),
  },
  preferencesGet: {
    input: z.null(),
    output: z.object({ preferences: preferencesSchema }).strict(),
  },
  /** Merges into the stored preferences, so each settings section saves only its own fields. */
  preferencesSet: {
    input: z.object({ preferences: preferencesPatchSchema }).strict(),
    output: z.object({ preferences: preferencesSchema }).strict(),
  },
  /** What Jev is told about each connected machine. */
  machines: {
    input: z.null(),
    output: z
      .object({
        machines: z.array(
          z
            .object({
              id: z.string(),
              name: z.string(),
              description: z.string(),
              stats: machineStatsSchema.nullable(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
  /**
   * Get ready for a dispatch while the user is still typing: open the
   * connection to Jev and refresh the facts about machines and projects.
   */
  warm: {
    input: z.null(),
    output: z.object({ warmed: z.boolean() }).strict(),
  },
  rotationGet: {
    input: z.null(),
    output: z.object({ entries: rotationSchema }).strict(),
  },
  rotationSet: {
    input: z.object({ entries: rotationSchema }).strict(),
    output: z.object({ entries: rotationSchema }).strict(),
  },
  /** The scope, plus every project and environment it could include. */
  scopeGet: {
    input: z.null(),
    output: z
      .object({
        scope: scopeSchema,
        projects: z.array(
          z.object({ id: z.string(), name: z.string(), detail: z.string() }).strict(),
        ),
        environments: z.array(
          z.object({ id: z.string(), name: z.string(), detail: z.string() }).strict(),
        ),
      })
      .strict(),
  },
  /** Merges into the stored scope, so each settings section saves only its own fields. */
  scopeSet: {
    input: z.object({ scope: scopePatchSchema }).strict(),
    output: z.object({ scope: scopeSchema }).strict(),
  },
  /** A starting value for a new rotation row: the default provider's default model. */
  rotationSeed: {
    input: z.null(),
    output: z.object({ seed: rotationEntrySchema.nullable() }).strict(),
  },
  /** Ask Jev where a prompt would go without starting anything. */
  preview: {
    input: z
      .object({
        text: promptSchema,
        /** Route within this project only, for a composer whose project Magic Compose may not set. */
        projectId: z.string().min(1).nullable().default(null),
      })
      .strict(),
    output: z.object({ decision: decisionSchema }).strict(),
  },
});

/** What the Projects and Environments settings sections render. */
export type ScopeOptions = z.infer<(typeof rpcContract)["scopeGet"]["output"]>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class NoAnswer extends Data.TaggedError("NoAnswer")<{ readonly message: string }> {}

/**
 * `call`, given `ms` to answer. Past that it is aborted, and its caller moves
 * on even if it ignores the abort.
 */
function deadline<A>(ms: number, call: (signal: AbortSignal) => Promise<A>) {
  return Effect.tryPromise({ try: async (signal) => call(signal), catch: (error) => error }).pipe(
    Effect.timeoutOrElse({
      duration: ms,
      orElse: () => Effect.fail(new NoAnswer({ message: `no answer within ${ms / 1000}s` })),
    }),
  );
}

/** Past `FACT_WAIT_MS`, a dispatch goes on without the fact. */
const unlessSlow = Effect.timeoutOrElse({
  duration: FACT_WAIT_MS,
  orElse: () => Effect.succeed(null),
});

/** Past a provider check, a dispatch goes on with `fallback`; the load carries on. */
const withinProviderCheck = <B>(fallback: B) =>
  Effect.timeoutOrElse({
    duration: PROVIDER_CHECK_TIMEOUT_MS,
    orElse: () => Effect.succeed(fallback),
  });

/** `work` for every item at once, by the item's id. */
function byId<T extends { id: string }, A, E, R>(
  items: readonly T[],
  work: (item: T) => Effect.Effect<A, E, R>,
) {
  return Effect.forEach(
    items,
    (item) => Effect.map(work(item), (value) => [item.id, value] as const),
    {
      concurrency: "unbounded",
    },
  ).pipe(Effect.map((entries) => new Map(entries)));
}

/** The plugin API, for the code that runs on the plugin's Effect runtime. */
class Bb extends Context.Service<Bb, BbPluginApi>()("magic-compose/Bb") {}

type EnvironmentProvider = Awaited<
  ReturnType<BbPluginApi["sdk"]["environments"]["listProviders"]>
>[number];
type ModelCatalog = Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["models"]>>;

/**
 * What a dispatch needs to know about each machine, project, and model
 * provider. It reads them through caches, so it never waits on a machine that
 * is slow to answer, and `warm` fills them while the user is still typing. A
 * read never fails: it logs why, and answers with what routing does without
 * the fact.
 */
class Facts extends Context.Service<
  Facts,
  {
    readonly machineStats: (hostId: string) => Effect.Effect<MachineStats | null>;
    /** Provider id → available, or null when the machine could not be asked. */
    readonly machineProviders: (hostId: string) => Effect.Effect<Map<string, boolean> | null>;
    /** None when the project's environments could not be read. */
    readonly environments: (projectId: string) => Effect.Effect<EnvironmentProvider[]>;
    /** Null when the provider's models could not be read. */
    readonly modelCatalog: (providerId: string) => Effect.Effect<ModelCatalog | null>;
    /** Load them again now, so a dispatch in the next moments finds them fresh. */
    readonly refresh: (
      hostIds: readonly string[],
      projectIds: readonly string[],
    ) => Effect.Effect<void>;
  }
>()("magic-compose/Facts") {
  static readonly layer = Layer.effect(
    Facts,
    Effect.gen(function* () {
      const bb = yield* Bb;
      const host = bb.hosts.experimental_client({ contract: hostContract });
      const stats = yield* makeSwrCache(
        (hostId) =>
          deadline(STATS_TIMEOUT_MS, (signal) => host.call("stats", null, { hostId, signal })),
        STATS_FRESH_MS,
        SERVE_STALE_MS,
      );
      const providers = yield* makeSwrCache(
        (hostId) =>
          Effect.map(
            deadline(PROVIDER_CHECK_TIMEOUT_MS, (signal) =>
              bb.sdk.providers.list({ hostId, signal }),
            ),
            (list) => new Map(list.map((entry) => [entry.id, entry.available] as const)),
          ),
        AVAILABILITY_FRESH_MS,
        SERVE_STALE_MS,
      );
      const environments = yield* makeSwrCache(
        (projectId) =>
          deadline(AVAILABILITY_LOAD_TIMEOUT_MS, (signal) =>
            bb.sdk.environments.listProviders({ projectId, signal }),
          ),
        AVAILABILITY_FRESH_MS,
        SERVE_STALE_MS,
      );
      const catalogs = yield* makeSwrCache(
        (providerId) =>
          deadline(AVAILABILITY_LOAD_TIMEOUT_MS, (signal) =>
            bb.sdk.providers.models({ providerId, signal }),
          ),
        AVAILABILITY_FRESH_MS,
        SERVE_STALE_MS,
      );

      // A caller that stops waiting, as a dispatch does after FACT_WAIT_MS,
      // leaves the read to finish, and to log if it fails.
      const reads = yield* FiberSet.make();
      const read = <A, E, B>(cache: SwrCache<A, E>, key: string, fallback: B, problem: string) =>
        FiberSet.run(
          reads,
          cache
            .get(key)
            .pipe(
              Effect.catch((error) =>
                Effect.as(
                  Effect.logWarning(`${problem} for ${key}: ${messageOf(error)}`),
                  fallback,
                ),
              ),
            ),
        ).pipe(Effect.flatMap(Fiber.join));

      return Facts.of({
        machineStats: (hostId) => read(stats, hostId, null, "machine stats unavailable"),
        machineProviders: (hostId) => read(providers, hostId, null, "provider check failed"),
        environments: (projectId) => read(environments, projectId, [], "environments unavailable"),
        modelCatalog: (providerId) => read(catalogs, providerId, null, "model catalog unavailable"),
        refresh: (hostIds, projectIds) =>
          Effect.forEach(
            [
              ...hostIds.flatMap((hostId) => [stats.refresh(hostId), providers.refresh(hostId)]),
              ...projectIds.map((projectId) => environments.refresh(projectId)),
            ],
            (refresh) => Effect.ignore(refresh),
            { concurrency: "unbounded", discard: true },
          ),
      });
    }),
  );
}

function summarizePick<T>(pick: Pick<T>): z.infer<typeof pickSchema> {
  return {
    label: pick.label,
    source: pick.source,
    probability: pick.probability,
    confidence: pick.confidence,
    alternatives: pick.alternatives,
  };
}

function formatPercent(value: number | null): string {
  return value === null ? "" : ` ${Math.round(value * 100)}%`;
}

function formatDecision(decision: DecisionSummary): string {
  const line = (title: string, pick: z.infer<typeof pickSchema>) => {
    const how =
      pick.source === "only-option"
        ? " (only option)"
        : `${formatPercent(pick.probability)}${pick.source === "fallback" ? " (fallback)" : ""}`;
    const others = pick.alternatives
      .filter((alternative) => alternative.probability >= 0.05)
      .map((alternative) => `${alternative.label}${formatPercent(alternative.probability)}`)
      .join(", ");
    return `${title.padEnd(12)}${pick.label}${how}${others === "" ? "" : `   also: ${others}`}`;
  };
  return [
    line("Project", decision.project),
    line("Machine", decision.machine),
    line("Model", decision.model),
    line("Reasoning", decision.reasoning),
    line("Environment", decision.environment),
    `Decided in ${decision.latencyMs}ms`,
  ].join("\n");
}

function createServices(bb: BbPluginApi, runtime: PluginRuntime<Facts | JevTransport>) {
  const settings = bb.settings.define({
    gatewayApiKey: {
      type: "string",
      label: "Vercel AI Gateway API key",
      description:
        "One way to reach Jev; set this, an OpenRouter key, or both. Create one in the Vercel dashboard under AI Gateway → API keys. The free tier allows only about 10 Jev calls per 5 minutes; any Gateway credit lifts that.",
      secret: true,
    },
    openRouterApiKey: {
      type: "string",
      label: "OpenRouter API key",
      description:
        "The other way to reach Jev (typesafe/jev-1.13). Create one at https://openrouter.ai/keys.",
      secret: true,
    },
    jevProvider: {
      type: "select",
      label: "Jev provider",
      description:
        "Which key to route with. “auto” uses whichever key is set; with both set it asks the Vercel AI Gateway first and OpenRouter if that fails.",
      options: [...JEV_PROVIDER_CHOICES],
      default: "auto",
    },
  });

  async function readPreferences(): Promise<Preferences> {
    return readStoredPreferences(await bb.storage.kv.get(PREFERENCES_KEY));
  }

  async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
    const next = preferencesSchema.parse({ ...(await readPreferences()), ...patch });
    // Effort is chosen per model, so Magic Compose cannot set it for a model it did not pick.
    if (!next.maySet.model) next.maySet.effort = false;
    await bb.storage.kv.set(PREFERENCES_KEY, next);
    return next;
  }

  /** The declared settings and the preferences, as the one configuration they are. */
  async function readConfig() {
    const [connection, preferences] = await Promise.all([settings.get(), readPreferences()]);
    return { ...connection, ...preferences };
  }

  async function readRotation(): Promise<RotationEntry[]> {
    const parsed = rotationSchema.safeParse(await bb.storage.kv.get(ROTATION_KEY));
    return parsed.success ? parsed.data : [];
  }

  async function readScope(): Promise<Scope> {
    const parsed = storedScopeSchema.safeParse(await bb.storage.kv.get(SCOPE_KEY));
    if (!parsed.success) return DEFAULT_SCOPE;
    // Magic Compose always needs somewhere to run and some effort to run at.
    return {
      ...parsed.data,
      environmentIds:
        parsed.data.environmentIds.length === 0 ? DEFAULT_ENVIRONMENTS : parsed.data.environmentIds,
      reasoningLevels:
        parsed.data.reasoningLevels === undefined || parsed.data.reasoningLevels.length === 0
          ? [...DEFAULT_REASONING_LEVELS]
          : parsed.data.reasoningLevels,
    };
  }

  /** The ways to reach Jev that are set up, in the order to try them. */
  async function jevRoutes(): Promise<JevRoute[]> {
    const config = await readConfig();
    const secret = (value: unknown) =>
      typeof value === "string" && value.trim() !== "" ? value.trim() : null;
    const keys = {
      vercel: secret(config.gatewayApiKey),
      openrouter: secret(config.openRouterApiKey),
    };
    const models = { vercel: config.jevModel, openrouter: config.openRouterJevModel };
    const order: JevProvider[] =
      config.jevProvider === "vercel" || config.jevProvider === "openrouter"
        ? [config.jevProvider]
        : ["vercel", "openrouter"];
    return order.flatMap((provider): JevRoute[] => {
      const apiKey = keys[provider];
      return apiKey === null ? [] : [{ provider, apiKey, model: models[provider] }];
    });
  }

  /** The connected machines, with how many threads each is running right now. */
  async function loadMachines() {
    const [hosts, systemConfig, running] = await Promise.all([
      bb.sdk.hosts.list(),
      bb.sdk.system.config(),
      bb.sdk.threads.count({ groupBy: "host", status: "active" }),
    ]);
    const runningByHost = new Map(
      (running.groups ?? []).map((group) => [group.key, group.count] as const),
    );
    const connected = hosts.filter(
      (entry) => entry.status === "connected" && entry.lifecycle.phase === "active",
    );
    const candidate = (
      entry: (typeof hosts)[number],
      stats: MachineStats | null,
      projectPath: string | null,
      environmentIds: string[],
    ): MachineCandidate => ({
      id: entry.id,
      name: entry.name,
      isServer: entry.id === systemConfig.primaryHostId,
      stats,
      runningThreads: runningByHost.get(entry.id) ?? 0,
      projectPath,
      environmentIds,
    });
    return { hosts, connected, candidate };
  }

  async function loadProjects(scope: Scope): Promise<ProjectCandidate[]> {
    const projects = await bb.sdk.projects.list({ includePersonal: true, include: "threads" });
    const candidates: ProjectCandidate[] = [];
    for (const project of projects) {
      const isPersonal = project.kind === "personal";
      if (!scope.allProjects && !scope.projectIds.includes(project.id)) continue;
      const threads = "threads" in project ? project.threads : [];
      candidates.push({
        id: project.id,
        name: project.name,
        isPersonal,
        gitRemoteUrl: project.gitRemoteUrl,
        sources: project.sources.map((source) => ({ hostId: source.hostId, path: source.path })),
        recentThreadTitles: threads
          .filter((thread) => thread.archivedAt === null)
          .map((thread) => (thread.title ?? thread.titleFallback ?? "").trim().slice(0, 80))
          .filter((title) => title !== "")
          .slice(0, RECENT_TITLES_PER_PROJECT),
      });
    }
    return candidates;
  }

  const loadModels = Effect.fnUntraced(function* (rotation: RotationEntry[]) {
    const facts = yield* Facts;
    const loaded = yield* Effect.forEach(
      [...new Set(rotation.map((entry) => entry.providerId))],
      (providerId) =>
        facts.modelCatalog(providerId).pipe(
          withinProviderCheck(null),
          Effect.map((catalog) => (catalog === null ? [] : [[providerId, catalog] as const])),
        ),
      { concurrency: "unbounded" },
    );
    const catalogs = new Map<string, ModelCatalog>(loaded.flat());
    const models = rotation.map((entry): ModelCandidate => {
      const catalog = catalogs.get(entry.providerId);
      const model = catalog?.models.find((candidate) => candidate.model === entry.model);
      const provider = catalog?.providers.find((candidate) => candidate.id === entry.providerId);
      return {
        ...entry,
        providerName: provider?.displayName ?? entry.providerId,
        displayName: model?.displayName ?? entry.model,
        description: model?.description ?? "",
      };
    });
    return { models, catalogs };
  });

  interface RoutedThread {
    decision: RouteDecision;
    profiler: Profiler;
    /** Null for a provider that declares no inputs, else its all-defaults inputs. */
    environmentInputs: Record<string, never> | null;
    permissionMode: PermissionMode;
  }

  /** Providers Magic Compose can fill in by itself: no new machine, no inputs only a person can give. */
  function isAutomatic(provider: EnvironmentProvider): boolean {
    return (
      provider.machineProviderId === null &&
      (provider.inputs === null || provider.acceptsEmptyInputs)
    );
  }

  /** How the last question to Jev went, for the settings page. Not kept across loads. */
  let lastAsked: { at: number; latencyMs: number | null; error: string | null } | null = null;

  /**
   * Decide where `text` should run. With `projectId`, within that project
   * only, whether or not it is one Magic Compose may choose: that is for a composer
   * whose project Magic Compose has been told to leave alone.
   */
  function decide(text: string, projectId: string | null = null) {
    return decideWithin(text, projectId).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) {
            lastAsked = { at: Date.now(), latencyMs: exit.value.profiler.elapsed(), error: null };
          } else if (!Cause.hasInterruptsOnly(exit.cause)) {
            lastAsked = {
              at: Date.now(),
              latencyMs: null,
              error: messageOf(Cause.squash(exit.cause)),
            };
          }
        }),
      ),
    );
  }

  const decideWithin = Effect.fnUntraced(function* (
    text: string,
    projectId: string | null,
  ): Effect.fn.Return<RoutedThread, RouteError, Facts | JevTransport> {
    const facts = yield* Facts;
    const profiler = new Profiler();
    const config = yield* profiler.time(
      "settings",
      Effect.promise(() => readConfig()),
    );
    const routes = yield* profiler.time(
      "settings.keys",
      Effect.promise(() => jevRoutes()),
    );
    if (routes.length === 0) {
      return yield* Effect.fail(
        new RouteError(
          config.jevProvider === "auto"
            ? "Add a Vercel AI Gateway or OpenRouter API key in Magic Compose settings first."
            : config.jevProvider === "openrouter"
              ? "Add an OpenRouter API key in Magic Compose settings, or set the Jev provider to auto."
              : "Add a Vercel AI Gateway API key in Magic Compose settings, or set the Jev provider to auto.",
        ),
      );
    }
    const rotation = yield* profiler.time(
      "kv.rotation",
      Effect.promise(() => readRotation()),
    );
    if (rotation.length === 0) {
      return yield* Effect.fail(
        new RouteError("Add at least one model to the rotation in Magic Compose settings."),
      );
    }

    const scope = yield* profiler.time(
      "kv.scope",
      Effect.promise(() => readScope()),
    );
    const [projects, { models, catalogs }, { hosts, connected, candidate }] = yield* Effect.all(
      [
        profiler.time(
          "load.projects",
          Effect.promise(async () =>
            projectId === null
              ? loadProjects(scope)
              : (await loadProjects({ ...scope, allProjects: true })).filter(
                  (project) => project.id === projectId,
                ),
          ),
        ),
        profiler.time("load.modelCatalogs", loadModels(rotation)),
        profiler.time(
          "load.machines",
          Effect.promise(() => loadMachines()),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (connected.length === 0) {
      return yield* Effect.fail(new RouteError("No machine is connected."));
    }
    // A project checked out only on machines that are offline cannot run
    // anywhere right now, so it is not worth offering.
    const online = new Set(connected.map((entry) => entry.id));
    const reachable = projects.filter(
      (project) =>
        project.isPersonal || project.sources.some((source) => online.has(source.hostId)),
    );
    if (reachable.length === 0) {
      return yield* Effect.fail(
        new RouteError(
          projectId !== null
            ? "The composer's project is not on a connected machine."
            : projects.length === 0
              ? "Pick at least one project for Magic Compose in Magic Compose settings."
              : "None of the projects Magic Compose may use is on a connected machine.",
        ),
      );
    }
    // Everything code must know before Jev is asked anything: what each
    // machine is doing, which providers it runs, and which environments it can
    // create for each project. All cached, all fetched side by side.
    const [statsByHost, providersByHost, environmentsByProject] = yield* Effect.all(
      [
        profiler.time(
          "facts.machineStats",
          byId(connected, (entry) => facts.machineStats(entry.id).pipe(unlessSlow)),
        ),
        profiler.time(
          "facts.machineProviders",
          byId(connected, (entry) => facts.machineProviders(entry.id).pipe(unlessSlow)),
        ),
        profiler.time(
          "facts.environments",
          byId(reachable, (project) =>
            facts.environments(project.id).pipe(withinProviderCheck([])),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    let permissionMode: PermissionMode =
      PERMISSION_MODES.find((mode) => mode === config.permissionMode) ?? "auto";

    interface TargetDetail extends Targets {
      usedFallback: boolean;
      inputs: Map<string, RoutedThread["environmentInputs"]>;
    }
    const targetDetails = new Map<string, TargetDetail>();
    /** Where `project` can run with `model`, from the facts above. No I/O. */
    function targetsFor(project: ProjectCandidate, model: ModelCandidate): TargetDetail {
      const cacheKey = `${project.id}\u0000${model.providerId}`;
      const cached = targetDetails.get(cacheKey);
      if (cached !== undefined) return cached;

      const usable = (environmentsByProject.get(project.id) ?? []).filter(
        (provider) => provider.requires.projectless === project.isPersonal && isAutomatic(provider),
      );
      // The environments the user allowed, in their order. A projectless
      // thread takes whichever projectless provider is installed. A project
      // none of them can serve (not a git repository, say) still gets a
      // plain checkout rather than no thread.
      const chosen = project.isPersonal
        ? usable
        : scope.environmentIds.flatMap((id) => usable.filter((provider) => provider.id === id));
      const fallback = usable.filter(
        (provider) => provider.id === FALLBACK_ENVIRONMENT && !chosen.includes(provider),
      );
      let detail: TargetDetail = {
        machines: [],
        environments: [],
        usedFallback: false,
        inputs: new Map(),
      };
      for (const tier of [chosen, fallback]) {
        const environmentsByMachine = new Map<string, string[]>();
        for (const provider of tier) {
          const anyMachine =
            project.isPersonal && Object.keys(provider.machineAvailability).length === 0;
          for (const entry of connected) {
            if (!anyMachine && provider.machineAvailability[entry.id]?.status !== "available") {
              continue;
            }
            environmentsByMachine.set(entry.id, [
              ...(environmentsByMachine.get(entry.id) ?? []),
              provider.id,
            ]);
          }
        }
        // A machine whose providers could not be read, or that does not list
        // this one yet, counts as able; spawn has the final say.
        const runnable = connected.filter(
          (entry) =>
            environmentsByMachine.has(entry.id) &&
            (providersByHost.get(entry.id)?.get(model.providerId) ?? true),
        );
        if (runnable.length === 0) continue;

        const offered = new Set(
          runnable.flatMap((entry) => environmentsByMachine.get(entry.id) ?? []),
        );
        detail = {
          usedFallback: tier === fallback,
          inputs: new Map(
            tier.map((provider) => [provider.id, provider.inputs === null ? null : {}] as const),
          ),
          machines: runnable.map((entry) =>
            candidate(
              entry,
              statsByHost.get(entry.id) ?? null,
              project.sources.find((source) => source.hostId === entry.id)?.path ?? null,
              environmentsByMachine.get(entry.id) ?? [],
            ),
          ),
          environments: tier
            .filter((provider) => offered.has(provider.id))
            .map((provider) => ({
              id: provider.id,
              name: provider.displayName,
              description: provider.description ?? "",
            })),
        };
        break;
      }
      targetDetails.set(cacheKey, detail);
      return detail;
    }

    let requests = 0;
    // The router asks through a callback; each ask runs as part of this work.
    const run = Effect.runPromiseWith(yield* Effect.context<JevTransport>());
    const routed = yield* Effect.promise((signal) =>
      route({
        task: text,
        instructions: {
          general: config.generalInstructions,
          projects: config.projectInstructions,
          machines: config.machineInstructions,
          models: config.modelInstructions,
          environments: config.environmentInstructions,
        },
        projects: reachable,
        models,
        hostNames: new Map(hosts.map((entry) => [entry.id, entry.name] as const)),
        reasoningLevels: scope.reasoningLevels,
        ask: (batch) => {
          const count = Object.keys(batch.questions).length;
          return run(
            profiler.time(
              `jev.request${++requests} (${count} questions)`,
              askChoicesVia(routes, batch),
            ),
            { signal },
          );
        },
        targetsFor,
        reasoningFor(model): ReasoningCandidate[] {
          const entry = catalogs
            .get(model.providerId)
            ?.models.find((candidate) => candidate.model === model.model);
          return (entry?.supportedReasoningEfforts ?? []).flatMap((effort) => {
            const level = parseReasoningLevel(effort.reasoningEffort);
            return level === null ? [] : [{ level, description: effort.description }];
          });
        },
      }),
    );

    const chosenTargets = targetsFor(routed.project.value, routed.model.value);
    const usedFallbackEnvironment = chosenTargets.usedFallback;
    const inputsByEnvironment = chosenTargets.inputs;

    const decision: RouteDecision = usedFallbackEnvironment
      ? { ...routed, environment: { ...routed.environment, source: "fallback" } }
      : routed;

    // A thread may not ask for more than its machine or provider grants, so
    // take the most permissive mode at or below both the setting and the ceiling.
    const machine = hosts.find((entry) => entry.id === decision.machine.value.id);
    const providerModes = catalogs
      .get(decision.model.value.providerId)
      ?.providers.find((provider) => provider.id === decision.model.value.providerId)
      ?.capabilities.permissionModes;
    const limit = Math.min(
      PERMISSION_MODES.indexOf(permissionMode),
      PERMISSION_MODES.indexOf(machine?.maxPermissionMode ?? "full"),
    );
    permissionMode =
      PERMISSION_MODES.filter(
        (mode, rank) =>
          rank <= limit && (providerModes === undefined || providerModes.includes(mode)),
      ).at(-1) ?? permissionMode;

    return {
      decision,
      profiler,
      environmentInputs: inputsByEnvironment.get(decision.environment.value.id) ?? {},
      permissionMode,
    };
  });

  function summarize(routed: RoutedThread): DecisionSummary {
    const { decision } = routed;
    return {
      project: { ...summarizePick(decision.project), id: decision.project.value.id },
      machine: { ...summarizePick(decision.machine), id: decision.machine.value.id },
      model: {
        ...summarizePick(decision.model),
        providerId: decision.model.value.providerId,
        model: decision.model.value.model,
      },
      reasoning: summarizePick(decision.reasoning),
      environment: { ...summarizePick(decision.environment), id: decision.environment.value.id },
      latencyMs: routed.profiler.elapsed(),
      timings: [...routed.profiler.spans],
    };
  }

  function userFacing(error: unknown): Error {
    if (error instanceof JevError || error instanceof RouteError) return error;
    bb.log.error(
      `dispatch failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    return new Error(messageOf(error));
  }

  /**
   * Route `text` and start the thread there. What `bb magic-compose spawn`
   * runs. `signal` stops the routing. A spawn already under way runs outside
   * it: the bridge reports any run the signal interrupts as aborted, and that
   * thread starts whether or not anyone is still waiting for it.
   */
  async function dispatch(text: string, signal?: AbortSignal) {
    const routed = await runtime.run(decide(text), signal);
    signal?.throwIfAborted();
    return runtime.run(startThread(routed, text));
  }

  /** Start the thread `routed` chose, and log where it went. Nothing interrupts the two. */
  const startThread = Effect.fnUntraced(function* (routed: RoutedThread, text: string) {
    const summary = summarize(routed);
    const projectId = summary.project.id;
    const thread = yield* routed.profiler.time(
      "threads.spawn",
      Effect.promise(async () =>
        bb.sdk.threads.spawn({
          projectId,
          providerId: summary.model.providerId,
          model: summary.model.model,
          reasoningLevel: routed.decision.reasoning.value,
          permissionMode: routed.permissionMode,
          environment: {
            type: "provider",
            environmentProviderId: summary.environment.id,
            inputs: routed.environmentInputs,
            machine: { type: "existing", hostId: summary.machine.id },
          },
          input: [{ type: "text", text, mentions: [] }],
          pluginMetadata: { decision: { ...summary, timings: [] } },
        }),
      ),
    );
    yield* Effect.logInfo(
      `dispatched ${thread.id}: ${summary.project.label} · ${summary.machine.label} · ${summary.model.label} · ${summary.reasoning.label} · ${summary.environment.label} (decided in ${summary.latencyMs}ms, ${routed.profiler.spans
        .filter((span) => !span.name.startsWith("facts.") && span.endMs - span.startMs >= 20)
        .map((span) => `${span.name} ${span.endMs - span.startMs}ms`)
        .join(", ")})`,
    );
    // Summarized again so the timings cover the spawn as well.
    return { threadId: thread.id, decision: summarize(routed) };
  }, Effect.uninterruptible);

  /** What Jev is told about each connected machine. */
  const describeMachines = Effect.fnUntraced(function* () {
    const facts = yield* Facts;
    const { connected, candidate } = yield* Effect.promise(() => loadMachines());
    const machines = yield* Effect.forEach(
      connected,
      (entry) =>
        Effect.map(facts.machineStats(entry.id), (stats) => candidate(entry, stats, null, [])),
      { concurrency: "unbounded" },
    );
    return machines.map((machine) => ({
      id: machine.id,
      name: machine.name,
      description: describeMachine(machine),
      stats: machine.stats,
    }));
  });

  const handlers = {
    status: async () => {
      const routes = await jevRoutes();
      return {
        hasApiKey: routes.length > 0,
        rotationSize: (await readRotation()).length,
        gateways: routes.map((entry) => JEV_PROVIDERS[entry.provider].name),
        last: lastAsked,
      };
    },
    preferencesGet: async () => ({ preferences: await readPreferences() }),
    preferencesSet: async ({ preferences }) => ({
      preferences: await writePreferences(preferences),
    }),
    machines: async () => ({ machines: await runtime.run(describeMachines()) }),
    warm: () =>
      runtime.run(
        Effect.gen(function* () {
          const routes = yield* Effect.promise(() => jevRoutes());
          if (routes.length === 0) return { warmed: false };
          const [{ connected }, projects] = yield* Effect.all(
            [
              Effect.promise(() => loadMachines()),
              Effect.promise(async (signal) =>
                bb.sdk.projects.list({ includePersonal: true, signal }),
              ),
              warmRoutes(routes),
            ],
            { concurrency: "unbounded" },
          );
          // Refreshed, not just read, so a dispatch in the next moments finds them fresh.
          const facts = yield* Facts;
          yield* facts.refresh(
            connected.map((entry) => entry.id),
            projects.map((project) => project.id),
          );
          return { warmed: true };
        }),
      ),
    rotationGet: async () => ({ entries: await readRotation() }),
    rotationSet: async ({ entries }) => {
      await bb.storage.kv.set(ROTATION_KEY, entries);
      return { entries };
    },
    scopeGet: async () => {
      const [scope, projects, environments, hosts] = await Promise.all([
        readScope(),
        bb.sdk.projects.list({ includePersonal: true }),
        bb.sdk.environments.listProviders(),
        bb.sdk.hosts.list(),
      ]);
      const hostNames = new Map(hosts.map((entry) => [entry.id, entry.name] as const));
      return {
        scope,
        projects: projects.map((project) => {
          const source = project.sources.find((entry) => entry.isDefault) ?? project.sources[0];
          return project.kind === "personal"
            ? { id: project.id, name: "No project", detail: "Threads that belong to no repository" }
            : {
                id: project.id,
                name: project.name,
                detail:
                  source === undefined
                    ? ""
                    : `${source.path} on ${hostNames.get(source.hostId) ?? "an offline machine"}`,
              };
        }),
        environments: environments
          .filter((provider) => !provider.requires.projectless && isAutomatic(provider))
          .map((provider) => ({
            id: provider.id,
            name: provider.displayName,
            detail: provider.description ?? "",
          })),
      };
    },
    scopeSet: async ({ scope }) => {
      await bb.storage.kv.set(SCOPE_KEY, { ...(await readScope()), ...scope });
      return { scope: await readScope() };
    },
    rotationSeed: async () => {
      const { providers } = await bb.sdk.providers.models();
      const provider = providers.find((entry) => entry.available);
      if (provider === undefined) return { seed: null };
      const { models } = await bb.sdk.providers.models({ providerId: provider.id });
      const model = models.find((entry) => entry.isDefault) ?? models[0];
      if (model === undefined) return { seed: null };
      return {
        seed: {
          providerId: provider.id,
          model: model.model,
          note: "",
          reasoningLevel: parseReasoningLevel(model.defaultReasoningEffort) ?? "medium",
        },
      };
    },
    preview: async ({ text, projectId }) => {
      try {
        return { decision: summarize(await runtime.run(decide(text, projectId))) };
      } catch (error) {
        throw userFacing(error);
      }
    },
  } satisfies PluginRpcHandlers<typeof rpcContract>;

  const HISTORY_MAX_THREADS = 600;
  /**
   * Plugins whose threads the user starts from a composer, choosing the model
   * themselves. Any other plugin's threads (review bots, automations, this
   * plugin's own dispatches) were configured once, not chosen per task.
   */
  const COMPOSER_PLUGINS = ["quick-compose", "quick-chat"];
  const HISTORY_PROMPT_CHARS = 400;
  type Thread = Awaited<ReturnType<typeof bb.sdk.threads.list>>[number];
  const firstTurnSchema = z.object({
    initiator: z.string().optional(),
    input: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
    execution: z
      .object({ model: z.string().optional(), reasoningLevel: z.string().optional() })
      .optional(),
  });

  /**
   * The model and effort the user chose for each thread they started, newest
   * first. Threads started by plugins or automations are left out, this
   * plugin's included: those choices were not the user's.
   */
  const loadHistory = Effect.fnUntraced(function* (days: number, extraOrigins: readonly string[]) {
    const userOrigins = new Set([...COMPOSER_PLUGINS, ...extraOrigins]);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const [projects, threads] = yield* Effect.all(
      [
        Effect.promise(async (signal) => bb.sdk.projects.list({ includePersonal: true, signal })),
        Effect.gen(function* () {
          const all: Thread[] = [];
          for (let offset = 0; ; offset += 500) {
            const page = yield* Effect.promise(async (signal) =>
              bb.sdk.threads.list({ limit: 500, offset, signal }),
            );
            all.push(...page);
            if (page.length < 500) return all;
          }
        }),
      ],
      { concurrency: "unbounded" },
    );
    const projectNames = new Map(
      projects.map((project) => [
        project.id,
        project.kind === "personal" ? "No project" : project.name,
      ]),
    );
    const started = threads
      .filter(
        (thread) =>
          thread.createdAt >= cutoff &&
          thread.parentThreadId === null &&
          thread.visibility === "visible" &&
          thread.deletedAt === null &&
          (thread.originPluginId === null || userOrigins.has(thread.originPluginId ?? "")),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, HISTORY_MAX_THREADS);

    /** What the user chose for `thread`, from its first turn; null when it was not their choice. */
    const historyRow = (thread: Thread, firstTurn: unknown): HistoryRow | null => {
      const turn = firstTurnSchema.safeParse(firstTurn);
      if (!turn.success || turn.data.initiator !== "user") return null;
      const { model, reasoningLevel } = turn.data.execution ?? {};
      if (model === undefined || reasoningLevel === undefined) return null;
      return {
        threadId: thread.id,
        createdAt: thread.createdAt,
        project: projectNames.get(thread.projectId) ?? thread.projectId,
        providerId: thread.providerId,
        model,
        effort: reasoningLevel,
        prompt: (turn.data.input ?? [])
          .map((part) => (part.type === "text" ? (part.text ?? "") : ""))
          .join(" ")
          .replace(/\s+/gu, " ")
          .trim(),
      };
    };
    const rows = yield* Effect.forEach(
      started,
      (thread) =>
        Effect.tryPromise({
          try: async (signal) =>
            bb.sdk.threads.events.list({
              threadId: thread.id,
              limit: "1",
              order: "asc",
              types: ["client/turn/requested"],
              signal,
            }),
          catch: (error) => error,
        }).pipe(
          Effect.map(([first]) => historyRow(thread, first?.data)),
          // A thread whose first turn cannot be read is left out.
          Effect.orElseSucceed(() => null),
        ),
      { concurrency: 16 },
    );
    return rows.filter((entry) => entry !== null);
  });

  /**
   * Ask Jev, with the current rotation and instructions, which model and
   * effort it would pick for each past prompt. Only those two questions are
   * asked: the world is reduced to one project on one machine.
   */
  const backtest = Effect.fnUntraced(function* (rows: readonly HistoryRow[]) {
    const config = yield* Effect.promise(() => readConfig());
    const routes = yield* Effect.promise(() => jevRoutes());
    if (routes.length === 0) {
      return yield* Effect.fail(
        new RouteError("Add a Jev API key in Magic Compose settings first."),
      );
    }
    const [scope, { models, catalogs }] = yield* Effect.all(
      [
        Effect.promise(() => readScope()),
        Effect.flatMap(
          Effect.promise(() => readRotation()),
          (rotation) => loadModels(rotation),
        ),
      ],
      { concurrency: "unbounded" },
    );
    yield* warmRoutes(routes);
    const project: ProjectCandidate = {
      id: "backtest",
      name: "backtest",
      isPersonal: false,
      gitRemoteUrl: null,
      sources: [],
      recentThreadTitles: [],
    };
    const machine: MachineCandidate = {
      id: "backtest",
      name: "backtest",
      isServer: true,
      stats: null,
      runningThreads: 0,
      projectPath: null,
      environmentIds: ["backtest"],
    };
    const run = Effect.runPromiseWith(yield* Effect.context<JevTransport>());
    const results = yield* Effect.forEach(
      rows,
      (row) =>
        Effect.tryPromise({
          try: (signal) =>
            route({
              task: row.prompt,
              instructions: {
                general: config.generalInstructions,
                models: config.modelInstructions,
                projects: "",
                machines: "",
                environments: "",
              },
              projects: [project],
              models,
              hostNames: new Map(),
              reasoningLevels: scope.reasoningLevels,
              ask: (batch) => run(askChoicesVia(routes, batch), { signal }),
              targetsFor: () => ({
                machines: [machine],
                environments: [{ id: "backtest", name: "backtest", description: "" }],
              }),
              reasoningFor: (model) =>
                (
                  catalogs
                    .get(model.providerId)
                    ?.models.find((entry) => entry.model === model.model)
                    ?.supportedReasoningEfforts ?? []
                ).flatMap((effort) => {
                  const level = parseReasoningLevel(effort.reasoningEffort);
                  return level === null ? [] : [{ level, description: effort.description }];
                }),
            }),
          catch: (error) => error,
        }).pipe(
          Effect.map((decision): BacktestResult => ({
            row,
            model: decision.model.value.model,
            effort: decision.reasoning.value,
          })),
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning(`backtest skipped ${row.threadId}: ${messageOf(error)}`),
              null,
            ),
          ),
        ),
      { concurrency: 8 },
    );
    return results.filter((entry) => entry !== null);
  });

  const VALUE_FLAGS = new Set(["--days", "--map", "--exclude", "--limit", "--include-origin"]);
  function parseArgs(argv: readonly string[]) {
    const values = new Map<string, string[]>();
    const switches = new Set<string>();
    const rest: string[] = [];
    for (let at = 0; at < argv.length; at++) {
      const arg = argv[at] ?? "";
      if (VALUE_FLAGS.has(arg)) {
        const value = argv[++at];
        if (value === undefined) throw new Error(`${arg} needs a value.`);
        values.set(arg, [...(values.get(arg) ?? []), value]);
      } else if (arg.startsWith("--")) switches.add(arg);
      else rest.push(arg);
    }
    return { values, switches, rest };
  }

  const usage = [
    "Usage:",
    "  bb magic-compose route <prompt> [--json] [--profile]   Show where Jev would send a prompt; starts nothing",
    "  bb magic-compose spawn <prompt> [--json]   Route a prompt and start the thread",
    "  bb magic-compose machines [--json]         Show what Jev is told about each connected machine",
    "  bb magic-compose rotation get [--json]     Show the model rotation",
    "  bb magic-compose rotation set <json>       Replace it: [{providerId, model, note, reasoningLevel}, ...]",
    "  bb magic-compose preferences get [--json]  Show the instructions and the other preferences",
    "  bb magic-compose preferences set <key> <value>   Set one, for example modelInstructions",
    "  bb magic-compose history [--days 14] [--include-origin <plugin-id>]... [--json]",
    "                                             The model and effort you chose for each thread you started",
    "  bb magic-compose backtest [--days 14] [--map <regex>=<model>]... [--exclude <regex>] [--limit 250] [--json]",
    "                                             Route your past prompts through Jev and score agreement with what you chose",
  ].join("\n");
  const runCli = async (argv: string[], signal?: AbortSignal) => {
    let parsedArgs: ReturnType<typeof parseArgs>;
    try {
      parsedArgs = parseArgs(argv);
    } catch (error) {
      return { exitCode: 1, stderr: messageOf(error) };
    }
    const { values, switches } = parsedArgs;
    const json = switches.has("--json");
    const profile = switches.has("--profile");
    const [command, ...rest] = parsedArgs.rest;
    const days = Math.min(Math.max(Number(values.get("--days")?.[0] ?? 14) || 14, 1), 90);
    const timeline = (decision: DecisionSummary) =>
      profile ? `\n\n${formatSpans(decision.timings)}` : "";
    if (command === undefined || command === "help" || command === "--help") {
      return { exitCode: 0, stdout: usage };
    }
    if (command === "rotation") {
      const [action, ...payload] = rest;
      if (action === "set") {
        try {
          const raw: unknown = JSON.parse(payload.join(" "));
          const entries = rotationSchema.parse(
            Array.isArray(raw) ? raw : (raw as { entries?: unknown }).entries,
          );
          await bb.storage.kv.set(ROTATION_KEY, entries);
          return { exitCode: 0, stdout: `Rotation set to ${entries.length} model(s).` };
        } catch (error) {
          return { exitCode: 1, stderr: `Could not read the rotation: ${messageOf(error)}` };
        }
      }
      if (action !== undefined && action !== "get") return { exitCode: 1, stderr: usage };
      const entries = await readRotation();
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(entries)
          : entries.length === 0
            ? "The rotation is empty."
            : entries
                .map(
                  (entry) =>
                    `${entry.providerId} / ${entry.model} (fallback effort ${entry.reasoningLevel})\n  ${entry.note || "(no note)"}`,
                )
                .join("\n"),
      };
    }
    if (command === "preferences") {
      const [action, key, ...payload] = rest;
      if (action === "set") {
        if (key === undefined || !(key in DEFAULT_PREFERENCES)) {
          return {
            exitCode: 1,
            stderr: `Unknown preference. Known: ${Object.keys(DEFAULT_PREFERENCES).join(", ")}`,
          };
        }
        const text = payload.join(" ");
        // Text is taken as it is; a switch, a choice, or `maySet` is given as JSON.
        const current = DEFAULT_PREFERENCES[key as keyof Preferences];
        let value: unknown = text;
        if (typeof current !== "string") {
          try {
            value = JSON.parse(text);
          } catch {
            return {
              exitCode: 1,
              stderr: `${key} takes JSON, for example ${JSON.stringify(current)}`,
            };
          }
        }
        const patch = preferencesPatchSchema.safeParse({ [key]: value });
        if (!patch.success) {
          return {
            exitCode: 1,
            stderr: `Could not set ${key}: ${patch.error.issues[0]?.message ?? "invalid value"}`,
          };
        }
        await writePreferences(patch.data);
        return { exitCode: 0, stdout: `Set ${key}.` };
      }
      if (action !== undefined && action !== "get") return { exitCode: 1, stderr: usage };
      const preferences = await readPreferences();
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(preferences)
          : Object.entries(preferences)
              .map(([name, value]) =>
                typeof value === "string" && value.includes("\n")
                  ? `${name}:\n${value.replace(/^/gm, "  ")}`
                  : `${name}: ${typeof value === "string" ? value || "(empty)" : JSON.stringify(value)}`,
              )
              .join("\n"),
      };
    }
    if (command === "history") {
      const rows = await runtime.run(
        loadHistory(days, values.get("--include-origin") ?? []),
        signal,
      );
      const counts = tally(rows);
      if (json) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            days,
            threads: rows.length,
            counts,
            rows: rows.map((row) => ({
              ...row,
              prompt: row.prompt.slice(0, HISTORY_PROMPT_CHARS),
            })),
          }),
        };
      }
      return {
        exitCode: 0,
        stdout: [
          `${rows.length} threads you started in the last ${days} days:`,
          ...counts.map(
            (entry) =>
              `  ${entry.model.padEnd(28)} ${String(entry.total).padStart(4)}   ${Object.entries(
                entry.efforts,
              )
                .sort((a, b) => b[1] - a[1])
                .map(([effort, count]) => `${effort} ${count}`)
                .join(", ")}`,
          ),
          "Add --json for every thread's prompt, model, and effort.",
        ].join("\n"),
      };
    }
    if (command === "backtest") {
      try {
        const rotation = await readRotation();
        if (rotation.length === 0)
          throw new RouteError("The rotation is empty; there is nothing to test.");
        const limit = Math.min(Math.max(Number(values.get("--limit")?.[0] ?? 250) || 250, 1), 500);
        const excludeText = values.get("--exclude")?.[0];
        const selection = backtestRows(
          await runtime.run(loadHistory(days, values.get("--include-origin") ?? []), signal),
          {
            mappings: (values.get("--map") ?? []).map(parseMapping),
            exclude: excludeText === undefined ? null : new RegExp(excludeText, "iu"),
            rotation: new Set(rotation.map((entry) => entry.model)),
          },
        );
        const rows = selection.rows.slice(0, limit);
        const results = await runtime.run(backtest(rows), signal);
        const scope = await readScope();
        const scored = score(results, new Set(scope.reasoningLevels));
        const misses = results
          .filter(
            (result) => result.model !== result.row.model || result.effort !== result.row.effort,
          )
          .slice(0, 80)
          .map((result) => ({
            you: `${result.row.model} ${result.row.effort}`,
            jev: `${result.model} ${result.effort}`,
            prompt: result.row.prompt.slice(0, 200),
          }));
        const report = {
          days,
          skipped: selection.skipped,
          failed: rows.length - results.length,
          ...scored,
          misses,
        };
        if (json) return { exitCode: 0, stdout: JSON.stringify(report) };
        return {
          exitCode: 0,
          stdout: [
            `Backtested ${scored.prompts} past prompts from the last ${days} days.`,
            `Model:  agrees ${scored.model.agreementPercent}%   (always picking ${scored.model.mostCommon}: ${scored.model.alwaysMostCommonPercent}%)`,
            `Effort: agrees ${scored.effort.agreementPercent}%, within one level ${scored.effort.withinOneLevelPercent}%   (always picking ${scored.effort.mostCommon}: ${scored.effort.alwaysMostCommonPercent}%)`,
            `Left out: ${Object.entries(selection.skipped)
              .map(([why, count]) => `${count} ${why}`)
              .join(", ")}.`,
            "Add --json for the confusion tables and every disagreement.",
          ].join("\n"),
        };
      } catch (error) {
        return { exitCode: 1, stderr: messageOf(error) };
      }
    }
    if (command === "machines") {
      const described = await runtime.run(describeMachines(), signal);
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(described)
          : described.length === 0
            ? "No machine is connected."
            : described.map((machine) => `${machine.name}\n  ${machine.description}`).join("\n"),
      };
    }
    if (command !== "route" && command !== "spawn") return { exitCode: 1, stderr: usage };
    const prompt = promptSchema.safeParse(rest.join(" "));
    if (!prompt.success) return { exitCode: 1, stderr: usage };
    try {
      if (command === "route") {
        const decision = summarize(await runtime.run(decide(prompt.data), signal));
        return {
          exitCode: 0,
          stdout: json ? JSON.stringify(decision) : formatDecision(decision) + timeline(decision),
        };
      }
      const parsed = await dispatch(prompt.data, signal).catch((error: unknown) => {
        throw userFacing(error);
      });
      return {
        exitCode: 0,
        stdout: json
          ? JSON.stringify(parsed)
          : `Started ${parsed.threadId}\n${formatDecision(parsed.decision)}${timeline(parsed.decision)}`,
      };
    } catch (error) {
      return { exitCode: 1, stderr: messageOf(error) };
    }
  };

  return { handlers, runCli };
}

// Retain the upstream wire names for existing callers and the bundled tuning skill.
const legacyRpcContract = defineRpcContract({
  preferences_get: rpcContract.preferencesGet,
  preferences_set: rpcContract.preferencesSet,
  rotation_get: rpcContract.rotationGet,
  rotation_set: rpcContract.rotationSet,
  scope_get: rpcContract.scopeGet,
  scope_set: rpcContract.scopeSet,
  rotation_seed: rpcContract.rotationSeed,
});

type Services = ReturnType<typeof createServices>;
/** What every command receives: the host plus the plugin services. */
type PluginContext = Readonly<{ bb: BbPluginApi } & Services>;
const options = {
  days: { type: "string", description: "Look back this many days (1–90)." },
  map: {
    type: "string",
    description: "Map a historical model: <regex>=<model>; repeatable.",
    repeatable: true,
  },
  exclude: { type: "string", description: "Exclude historical prompts matching this regex." },
  limit: { type: "string", description: "Maximum number of results." },
  "include-origin": {
    type: "string",
    description: "Include threads from this plugin origin; repeatable.",
    repeatable: true,
  },
  json: { type: "boolean", description: "Print the result as JSON." },
  profile: { type: "boolean", description: "Include routing timing details." },
} as const;

type CommandSpec = {
  name: string;
  summary: string;
  description: string;
  optionKeys: readonly (keyof typeof options)[];
  positionals?: readonly PluginCliPositional[];
};
function forwardCommand(ctx: PluginContext, spec: CommandSpec) {
  const positionals = spec.positionals ?? [];
  return cliCommand({
    summary: spec.summary,
    description: spec.description,
    options: Object.fromEntries(spec.optionKeys.map((key) => [key, options[key]])),
    positionals,
    run: (input, cli) =>
      ctx.runCli(
        [
          spec.name,
          ...positionals.flatMap(({ name }) => {
            const value = input.positionals[name];
            return value === undefined ? [] : Array.isArray(value) ? value : [value];
          }),
          ...Object.entries(input.options).flatMap(([key, value]) =>
            value === undefined || value === false
              ? []
              : value === true
                ? [`--${key}`]
                : (Array.isArray(value) ? value : [value]).flatMap((item) => [
                    `--${key}`,
                    String(item),
                  ]),
          ),
        ],
        cli.signal,
      ),
  });
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  // The plugin's warm connections and cached facts live until it is unloaded.
  const runtime = await makePluginRuntime(
    bb,
    Layer.mergeAll(Facts.layer, JevTransport.layer).pipe(Layer.provide(Layer.succeed(Bb, bb))),
  );
  const ctx: PluginContext = Object.freeze({ bb, ...createServices(bb, runtime) });
  const { handlers } = ctx;
  bb.rpc.register(rpcContract, handlers);
  bb.cli.register(
    defineCli({
      name: "magic-compose",
      summary: "CLI for the magic-compose plugin",
      commands: {
        route: forwardCommand(ctx, {
          name: "route",
          summary: "Show where Jev would send a prompt",
          description:
            "Usage: bb magic-compose route <prompt> [--json] [--profile]. Starts no thread.",
          optionKeys: ["json", "profile"],
          positionals: [
            { name: "prompt", description: "Prompt to route.", required: true, variadic: true },
          ],
        }),
        spawn: forwardCommand(ctx, {
          name: "spawn",
          summary: "Route a prompt and start its thread",
          description: "Usage: bb magic-compose spawn <prompt> [--json] [--profile].",
          optionKeys: ["json", "profile"],
          positionals: [
            {
              name: "prompt",
              description: "Prompt for the new thread.",
              required: true,
              variadic: true,
            },
          ],
        }),
        machines: forwardCommand(ctx, {
          name: "machines",
          summary: "Describe connected machines",
          description: "Usage: bb magic-compose machines [--json].",
          optionKeys: ["json"],
          positionals: [],
        }),
        rotation: forwardCommand(ctx, {
          name: "rotation",
          summary: "Get the rotation or set it from JSON",
          description:
            "Use bb magic-compose rotation get [--json], or rotation set <json>. JSON is a list of {providerId, model, note, reasoningLevel}.",
          optionKeys: ["json"],
          positionals: [
            { name: "action", description: "get (default) or set." },
            { name: "json", description: "Rotation JSON for set.", variadic: true },
          ],
        }),
        preferences: forwardCommand(ctx, {
          name: "preferences",
          summary: "Get preferences or set a key and value",
          description:
            "Use bb magic-compose preferences get [--json], or preferences set <key> <value>. Non-text values use JSON.",
          optionKeys: ["json"],
          positionals: [
            { name: "action", description: "get (default) or set." },
            { name: "key", description: "Preference name for set." },
            { name: "value", description: "Preference value for set.", variadic: true },
          ],
        }),
        history: forwardCommand(ctx, {
          name: "history",
          summary: "Show the models and effort you chose",
          description:
            "Usage: bb magic-compose history [--days 14] [--include-origin <plugin-id>]... [--json].",
          optionKeys: ["days", "include-origin", "json"],
          positionals: [],
        }),
        backtest: forwardCommand(ctx, {
          name: "backtest",
          summary: "Compare routing decisions with your past choices",
          description:
            "Usage: bb magic-compose backtest [--days 14] [--map <regex>=<model>]... [--exclude <regex>] [--limit 250] [--include-origin <plugin-id>]... [--json].",
          optionKeys: ["days", "map", "exclude", "limit", "include-origin", "json"],
          positionals: [],
        }),
      },
    }),
  );
  // Retain the upstream wire names for existing callers and the bundled tuning skill.
  bb.rpc.register(legacyRpcContract, {
    preferences_get: handlers.preferencesGet,
    preferences_set: handlers.preferencesSet,
    rotation_get: handlers.rotationGet,
    rotation_set: handlers.rotationSet,
    scope_get: handlers.scopeGet,
    scope_set: handlers.scopeSet,
    rotation_seed: handlers.rotationSeed,
  });
}
