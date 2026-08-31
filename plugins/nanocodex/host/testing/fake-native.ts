import type {
  AgentEvent,
  DefaultAgent,
  PromptInput,
  SessionSnapshot,
  Turn,
  TurnResult,
  TurnUsage,
} from "nanocodex/host";
import type { NativeAgentOptions, NativeBinding } from "../binding.ts";

export interface TurnPlan {
  readonly snapshot: SessionSnapshot;
  readonly hold?: boolean;
  readonly steerError?: Error;
}

export class FakeNativeBinding implements NativeBinding {
  readonly createCalls: NativeAgentOptions[] = [];
  readonly forkSeeds: SessionSnapshot[] = [];
  readonly agents: FakeAgent[] = [];
  readonly plans: TurnPlan[] = [];
  compactContext: { workspace: string; history: readonly Record<string, unknown>[] } | undefined;
  failNextPromotion = false;
  closed = false;

  async createAgent(options: NativeAgentOptions): Promise<DefaultAgent> {
    this.createCalls.push(options);
    if (
      this.failNextPromotion &&
      options.durability !== undefined &&
      options.resume !== undefined
    ) {
      this.failNextPromotion = false;
      throw new Error("promotion failed");
    }
    return this.newAgent(options.resume).value;
  }

  newAgent(resume?: SessionSnapshot): FakeAgent {
    const agent = new FakeAgent(this, resume);
    this.agents.push(agent);
    return agent;
  }

  health(): Promise<{ state: "signed_out" }> {
    return Promise.resolve({ state: "signed_out" });
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class FakeAgent {
  readonly value: DefaultAgent;
  readonly events: AgentEvent[] = [];
  readonly prompts: PromptInput[] = [];
  shutdowns = 0;
  compactCalls = 0;
  snapshot: SessionSnapshot | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private sequence = 0;

  constructor(
    private readonly binding: FakeNativeBinding,
    resume?: SessionSnapshot,
  ) {
    this.snapshot = resume;
    const sessionId = `session-${binding.agents.length + 1}`;
    this.value = {
      agentId: sessionId,
      key: sessionId,
      name: "fake",
      sessionId,
      type: "fake",
      uid: sessionId,
      extend: (() => {
        throw new Error("unused");
      }) as DefaultAgent["extend"],
      dispose() {},
      events: {
        watch: () => ({
          onEvent: (listener) => {
            this.listeners.add(listener);
            return () => this.listeners.delete(listener);
          },
          off: () => this.listeners.clear(),
          async *[Symbol.asyncIterator]() {},
        }),
      },
      session: {
        appendDeveloperMessage: async () => this.context(),
        compact: async () => {
          this.compactCalls += 1;
          this.emit("model.compaction.started", {});
          this.emit("model.compaction.completed", {});
        },
        context: async () => this.context(),
        fork: async () => {
          if (this.snapshot === undefined) throw new Error("fork needs a snapshot");
          this.binding.forkSeeds.push(this.snapshot);
          return this.binding.newAgent(this.snapshot).value;
        },
        setFastMode: async () => {},
        setThinking: async () => {},
        shutdown: async () => {
          this.shutdowns += 1;
        },
        spawn: async () => this.binding.newAgent(this.snapshot).value,
        realtime: {
          start: async () => this.context(),
          end: async () => this.context(),
          delegation: async () => "",
          tailDelegation: async () => undefined,
        },
      },
      turn: { prompt: ({ input }) => this.prompt(input) },
    };
  }

  private context() {
    return (
      this.binding.compactContext ?? {
        workspace: this.snapshot?.workspace ?? "/workspace",
        history: this.snapshot?.history ?? [],
      }
    );
  }

  private prompt(input: PromptInput): Turn {
    this.prompts.push(input);
    const plan = this.binding.plans.shift();
    if (plan === undefined) throw new Error("No fake turn plan was queued");
    let rejectResult!: (error: unknown) => void;
    let resolveResult!: (result: TurnResult) => void;
    const pending = new Promise<TurnResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const result = fakeResult(plan.snapshot);
    if (!plan.hold) queueMicrotask(() => resolveResult(result));
    return {
      agent: this.value,
      accepted: async () => {
        this.emit("run.started", { model: plan.snapshot.model });
        this.emit("assistant.message", {
          model_call_index: 1,
          phase: "final_answer",
          text: "done",
        });
        return `request-${this.prompts.length}`;
      },
      result: async () => {
        const settled = await pending;
        this.snapshot = plan.snapshot;
        this.emit("run.completed", { status: "completed" });
        return settled;
      },
      steer: async () => {
        if (plan.steerError !== undefined) throw plan.steerError;
        this.emit("run.steered", {});
      },
      cancel: async () => {
        const error = Object.assign(new Error("cancelled"), { code: "cancelled" });
        rejectResult(error);
      },
      dispose() {},
    };
  }

  private emit(type: string, payload: Record<string, unknown>): void {
    const event: AgentEvent = {
      protocol_version: 1,
      request_id: this.value.sessionId,
      seq: ++this.sequence,
      type,
      payload,
    };
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }
}

export function snapshot(
  name: string,
  history: readonly Record<string, unknown>[] = [{ role: "assistant", content: name }],
): SessionSnapshot {
  return {
    version: 1,
    model: "gpt-5.6-sol",
    lineage_id: `lineage-${name}`,
    prompt_cache_key: `cache-${name}`,
    workspace: "/workspace",
    canonical_context: { name },
    history,
  };
}

function fakeResult(value: SessionSnapshot): TurnResult {
  const usage: TurnUsage = {
    input_tokens: 3,
    cached_input_tokens: 1,
    cache_write_input_tokens: 0,
    output_tokens: 2,
    reasoning_output_tokens: 1,
    total_tokens: 5,
    estimated_cost: null,
    cost_status: "usage_not_reported",
  };
  return {
    finalMessage: "done",
    snapshot: async () => value,
    usage: async () => usage,
    dispose() {},
  } as TurnResult;
}
