import { Agent } from "nanocodex/node";
import { chatGpt } from "nanocodex/node/transport";
import { ChatGptSubscription } from "nanocodex/worker";
import type {
  ChatGptLoginStatus,
  ChatGptSubscriptionHandle,
  DefaultAgent,
  Model,
  NamedTool,
  SessionSnapshot,
  Thinking,
} from "nanocodex/host";
import type { DurabilityStore } from "nanocodex/durability";
import { inspectAuthSeed, readAuthSeed } from "../shared/node/auth-seed.ts";
import { NANOCODEX_WASM_BASE64, NANOCODEX_WASM_SHA256 } from "./generated/nanocodex-wasm.ts";
import { createParallelWebTool } from "./parallel-web.ts";
import type { NanocodexStorage } from "./storage.ts";

export interface NativeAgentOptions {
  readonly model: Model;
  readonly thinking: Thinking;
  readonly fastMode: boolean;
  readonly instructions?: string;
  readonly workspace: string;
  readonly sessionId?: string;
  readonly resume?: SessionSnapshot;
  readonly durability?: { readonly store: DurabilityStore; readonly id: string };
}

export type BindingHealth =
  | {
      readonly state: "authenticated";
      readonly accountId: string;
      readonly expiresAt: number | null;
    }
  | { readonly state: "signed_out" | "expired" }
  | {
      readonly state: "pending";
      readonly verificationUrl: string;
      readonly userCode: string;
      readonly expiresAt: number;
    }
  | { readonly state: "broken"; readonly message: string };

export interface NativeBinding {
  createAgent(options: NativeAgentOptions): Promise<DefaultAgent>;
  health(options?: { readonly beginLogin?: boolean }): Promise<BindingHealth>;
  close(): Promise<void>;
}

export interface BindingDependencies {
  readonly openSubscription?: typeof ChatGptSubscription.open;
  readonly createAgent?: typeof Agent.create;
  readonly readSeed?: typeof readAuthSeed;
  readonly inspectSeed?: typeof inspectAuthSeed;
  readonly parallelWebTool?: NamedTool;
}

let modulePromise: Promise<WebAssembly.Module> | undefined;

export function initializeEmbeddedNanocodexModule(): Promise<WebAssembly.Module> {
  modulePromise ??= WebAssembly.compile(Buffer.from(NANOCODEX_WASM_BASE64, "base64"));
  return modulePromise;
}

export { NANOCODEX_WASM_SHA256 };

export function createProcessBinding(
  storage: NanocodexStorage,
  dependencies: BindingDependencies = {},
): NativeBinding {
  const openSubscription = dependencies.openSubscription ?? ChatGptSubscription.open;
  const createAgent = dependencies.createAgent ?? Agent.create;
  const readSeed = dependencies.readSeed ?? readAuthSeed;
  const inspectSeed =
    dependencies.inspectSeed ?? (dependencies.readSeed === undefined ? inspectAuthSeed : undefined);
  const parallelWebTool = dependencies.parallelWebTool ?? createParallelWebTool();
  let subscriptionPromise: Promise<ChatGptSubscriptionHandle> | undefined;
  let authSeedProblem:
    | { readonly state: "expired" | "broken"; readonly message: string }
    | undefined;
  let closed = false;

  const subscription = (): Promise<ChatGptSubscriptionHandle> => {
    if (closed) return Promise.reject(new Error("The NanoCodex binding is closed"));
    subscriptionPromise ??= (async () => {
      const module = await initializeEmbeddedNanocodexModule();
      const inspected = await inspectSeed?.();
      if (inspected?.state === "expired" || inspected?.state === "broken") {
        authSeedProblem = { state: inspected.state, message: inspected.message };
      }
      const seed =
        inspected === undefined
          ? await readSeed()
          : inspected.state === "ready"
            ? inspected.seed
            : undefined;
      return openSubscription({
        id: "nanocodex",
        module,
        store: storage.subscription,
        seed,
      });
    })();
    return subscriptionPromise;
  };

  return {
    async createAgent(options) {
      const module = await initializeEmbeddedNanocodexModule();
      const transport = chatGpt({ subscription: await subscription() });
      const createStandardAgent = createAgent as (
        options: Agent.create.Options,
      ) => Promise<DefaultAgent>;
      const common = {
        module,
        transport,
        mcp: false as const,
        tools: [parallelWebTool],
        model: options.model,
        thinking: options.thinking,
        fastMode: options.fastMode,
        instructions: options.instructions,
        workspace: options.workspace,
        sessionId: options.sessionId,
        resume: options.resume,
      };
      return options.durability === undefined
        ? createStandardAgent(common)
        : createStandardAgent({
            ...common,
            durability: options.durability.store,
            durabilityId: options.durability.id,
          });
    },
    async health(options = {}) {
      try {
        const handle = await subscription();
        let status = await handle.status();
        if (
          (status.state === "signed_out" || status.state === "expired") &&
          authSeedProblem !== undefined
        ) {
          return authSeedProblem.state === "expired"
            ? { state: "expired" }
            : { state: "broken", message: authSeedProblem.message };
        }
        if (
          options.beginLogin === true &&
          (status.state === "signed_out" || status.state === "expired")
        ) {
          status = await handle.startLogin();
        }
        return healthFromStatus(status);
      } catch (error) {
        return { state: "broken", message: error instanceof Error ? error.message : String(error) };
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const pending = subscriptionPromise;
      if (pending !== undefined) (await pending).dispose();
    },
  };
}

function healthFromStatus(status: ChatGptLoginStatus): BindingHealth {
  switch (status.state) {
    case "authenticated":
      return { state: "authenticated", accountId: status.accountId, expiresAt: status.expiresAt };
    case "pending":
      return {
        state: "pending",
        verificationUrl: status.verificationUrl,
        userCode: status.userCode,
        expiresAt: status.expiresAt,
      };
    case "expired":
      return { state: "expired" };
    case "signed_out":
      return { state: "signed_out" };
  }
}
