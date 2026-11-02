import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  LOG_TEXT_PREVIEW,
  MAX_TEXT_LENGTH,
  type GrokbotStatus,
  type LogEntry,
  type SendInput,
  type SendOutcome,
  type ThreadContext,
} from "../shared/contract.ts";
import { loadConfig, publicStatus, type LoadedConfig } from "./config.ts";
import type { SendLog } from "./send-log.ts";
import { buildPayload, postWebhook, type WebhookPayload } from "./webhook.ts";

/** A thread's context plus its title, for the panel's preview. */
export type ThreadSummary = ThreadContext & { title: string | null };

/** Resolves a bb thread's context; tests substitute it. */
export type ThreadLookup = (threadId: string) => Promise<ThreadSummary>;

export interface GrokbotServiceDeps {
  readonly loadConfig?: () => Promise<LoadedConfig>;
  readonly lookupThread: ThreadLookup;
  readonly log: SendLog;
  readonly post?: (
    config: { url: string; key: string },
    payload: WebhookPayload,
  ) => Promise<SendOutcome>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export type RefusalCode =
  | "not_configured"
  | "unknown_bot"
  | "empty_text"
  | "too_long"
  | "thread_unavailable";

/** A send the config or input refused before any request went out. */
export class GrokbotRefusal extends Error {
  readonly code: RefusalCode;
  constructor(message: string, code: RefusalCode) {
    super(message);
    this.name = "GrokbotRefusal";
    this.code = code;
  }
}

/** `logged` is false when the request went out but the send log could not be written. */
export interface SendResult {
  outcome: SendOutcome;
  entry: LogEntry;
  logged: boolean;
}

export interface GrokbotService {
  status(): Promise<GrokbotStatus>;
  threadContext(threadId: string): Promise<ThreadSummary>;
  send(input: SendInput): Promise<SendResult>;
  recent(limit?: number): Promise<LogEntry[]>;
}

/**
 * The config file is reread on every call, so editing it takes effect
 * without a reload and a deleted file disables sending immediately.
 */
export function createGrokbotService(deps: GrokbotServiceDeps): GrokbotService {
  const load = deps.loadConfig ?? (() => loadConfig());
  const post = deps.post ?? ((config, payload) => postWebhook(config, payload));
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return {
    async status() {
      return publicStatus(await load());
    },
    threadContext: (threadId) => deps.lookupThread(threadId),
    async send(input) {
      const loaded = await load();
      if (loaded.state !== "ready") throw new GrokbotRefusal(loaded.reason, "not_configured");
      const targetBot = input.targetBot ?? null;
      if (targetBot !== null && !loaded.config.bots.some((bot) => bot.id === targetBot)) {
        throw new GrokbotRefusal(
          `Unknown bot "${targetBot}"; add it to bots in ${loaded.configPath}.`,
          "unknown_bot",
        );
      }
      const typed = (input.text ?? "").trim();
      const text = input.action === "ping" ? typed || "ping" : typed;
      if (text === "") throw new GrokbotRefusal("Type a message to send.", "empty_text");
      if (text.length > MAX_TEXT_LENGTH) {
        throw new GrokbotRefusal(
          `Messages are limited to ${MAX_TEXT_LENGTH} characters; this one has ${text.length}.`,
          "too_long",
        );
      }
      const context = input.threadId ? await threadContext(deps, input.threadId) : null;
      const payload = buildPayload({ action: input.action, targetBot, text, context, now: now() });
      const outcome = await post(loaded.config, payload);
      const entry: LogEntry = {
        id: newId(),
        ts: payload.ts,
        action: payload.action,
        target_bot: payload.target_bot,
        textPreview: preview(text),
        context,
        ...outcome,
      };
      // The request already went out: a log failure must not turn it into "not sent".
      const logged = await deps.log.append(entry).then(
        () => true,
        () => false,
      );
      return { outcome, entry, logged };
    },
    recent: (limit) => deps.log.recent(limit),
  };
}

async function threadContext(deps: GrokbotServiceDeps, threadId: string): Promise<ThreadContext> {
  try {
    const { thread_id, project, branch } = await deps.lookupThread(threadId);
    return { thread_id, project, branch };
  } catch {
    throw new GrokbotRefusal(`Cannot read bb thread ${threadId}.`, "thread_unavailable");
  }
}

function preview(text: string): string {
  return text.length > LOG_TEXT_PREVIEW ? `${text.slice(0, LOG_TEXT_PREVIEW - 1)}…` : text;
}

/** Resolve a thread's project name and branch through the SDK. */
export function sdkThreadLookup(bb: BbPluginApi): ThreadLookup {
  return async (threadId) => {
    const thread = await bb.sdk.threads.get({ threadId });
    const [project, environment] = await Promise.all([
      thread.projectId
        ? bb.sdk.projects.get({ projectId: thread.projectId }).catch(() => null)
        : null,
      thread.environmentId
        ? bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null)
        : null,
    ]);
    return {
      thread_id: thread.id,
      project: project?.name ?? thread.projectId ?? null,
      branch: environment?.branchName ?? null,
      title: thread.title ?? thread.titleFallback ?? null,
    };
  };
}
