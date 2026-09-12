// Authoritative shared contract for initiatives ("Projects" in the UI).
//
// One persistent project groups a coordinator conversation, agent threads
// dispatched across bound BB repositories/environments, server-authoritative
// context documents, and subscriptions. `projectId` stays BB's repository
// concept; an initiative binds one or more of them.
//
// This file is the single source of truth for wire DTOs. Frontend imports
// types from here; the initiativeRpcContract in lib/initiative-rpc.ts and the
// agent tools validate against the same shapes. Subscription row/config types
// live in initiative-subscriptions.ts (automation owns that module) and are
// re-exported here as types only, so importing this file from the frontend
// never pulls in server-only dependencies.
import type {
  GitHubCiConfig,
  GitHubPrConfig,
  InitiativeSubscription,
  InitiativeSubscriptionConfig,
  InitiativeSubscriptionKind,
  SlackChannelConfig,
  SubscriptionScheduleConfig,
} from "./initiative-subscriptions.ts";

export type {
  GitHubCiConfig,
  GitHubPrConfig,
  InitiativeSubscription,
  InitiativeSubscriptionConfig,
  InitiativeSubscriptionKind,
  SlackChannelConfig,
  SubscriptionScheduleConfig,
};

/** Realtime channel for initiative registry + context doc changes. */
export const INITIATIVES_CHANNEL = "initiatives";
export interface InitiativesChannelPayload {
  initiativeId: string | null;
}

/**
 * Realtime channel the subscription engine publishes on. Kept in sync with
 * `SUBSCRIPTIONS_REALTIME_CHANNEL` in initiative-subscriptions.ts — the backend
 * test asserts equality so the two literals cannot drift.
 */
export const SUBSCRIPTIONS_CHANNEL = "initiative-subscriptions";

export type InitiativeRole = "coordinator" | "agent";

export interface Initiative {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** The bb thread that hosts the coordinator conversation. */
  coordinatorThreadId: string;
  /**
   * Bound bb repository projects; index 0 is the primary workspace the
   * coordinator runs under. Empty = "from scratch" (personal project).
   */
  workspaceProjectIds: string[];
  /** Environment the coordinator was created against; null = repo default. */
  primaryEnvironmentId: string | null;
  providerId: string | null;
  model: string | null;
  reasoningLevel: string | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
}

/**
 * A thread descended from an initiative's coordinator. Membership is BB's
 * native parentThreadId ancestry — derived, never persisted — so agents
 * spawned outside the plugin (raw `bb thread spawn --parent-self`) still
 * count, and status stays whatever core reports.
 */
export interface InitiativeAgent {
  threadId: string;
  initiativeId: string;
  title: string | null;
  /** Core thread status, live. */
  status: string;
  /** The bb repository project this agent runs under (cross-repo ok). */
  projectId: string;
  environmentId: string | null;
  /** Distance below the coordinator: 1 = direct child. */
  depth: number;
  createdAt: number;
}

/**
 * One node in the shared context tree. Documents are rows in plugin SQLite —
 * virtual, server-authoritative, reachable identically from coordinator and
 * agents on any host. Directories are derived from file paths, never stored.
 */
export interface InitiativeContextDoc {
  /** Logical POSIX path, e.g. "notes/plan.md". */
  path: string;
  kind: "file" | "directory";
  sizeBytes: number;
  /** Monotonic integer CAS guard; directories report 0. */
  revision: number;
  updatedAt: number;
  children?: InitiativeContextDoc[];
}

/** One environment a bound repository offers (agent-spawn picker). */
export interface InitiativeEnvironment {
  id: string;
  projectId: string;
  name: string | null;
  status: "creating" | "provisioning" | "ready" | "error" | "destroyed";
  hostId: string;
  path: string | null;
  branchName: string | null;
  isWorktree: boolean;
  environmentProviderId: string | null;
}

/** A public environment provider selectable for a fresh agent environment. */
export interface InitiativeEnvironmentProvider {
  id: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  pluginId: string;
  available: boolean;
}

// ---------------------------------------------------------------------------
// RPC surface (methods live on initiativeRpcContract in lib/initiative-rpc.ts).
//
//   listInitiatives        { workspaceProjectId? }
//                        -> { initiatives: Initiative[] }
//   getInitiative          { initiativeId }
//                        -> { initiative, agents: InitiativeAgent[],
//                             coordinatorStatus: string | null,
//                             coordinatorAvailable: boolean }
//   initiativeForThread    { threadId }
//                        -> { initiative: Initiative | null, role: InitiativeRole | null }
//   createInitiative       { name, icon?, description?, workspaceProjectIds,
//                            environmentId?, providerId?, model?,
//                            reasoningLevel?, initialPrompt? }
//                        -> { initiative, threadId }
//   updateInitiative       { initiativeId, name?, icon?, description?,
//                            workspaceProjectIds?, providerId?, model?,
//                            reasoningLevel? }
//                        -> { initiative }
//   archiveInitiative      { initiativeId }            -> { ok: true }
//   unarchiveInitiative    { initiativeId }            -> { initiative }
//   deleteInitiative       { initiativeId }            -> { ok: true }
//   attachInitiativeThread { initiativeId, threadId }  -> { ok: true }
//   detachInitiativeThread { initiativeId, threadId }  -> { ok: true }
//   spawnInitiativeAgent   { initiativeId, prompt, title?, projectId?,
//                            environmentId?, providerId?, model?,
//                            reasoningLevel? }
//                        -> { threadId }
//   listInitiativeEnvironments { projectId }
//                        -> { environments: InitiativeEnvironment[] }
//   listEnvironmentProviders { projectId? }
//                        -> { providers: InitiativeEnvironmentProvider[] }
//   listContextDocs        { initiativeId }
//                        -> { docs: InitiativeContextDoc[] }
//   readContextDoc         { initiativeId, path }
//                        -> { path, content, revision }
//   writeContextDoc        { initiativeId, path, content, expectedRevision? }
//                        -> { outcome: "written" | "conflict", revision }
//   deleteContextDoc       { initiativeId, path }
//                        -> { ok: true, deletedCount }
//   listSubscriptions      { initiativeId }
//                        -> { subscriptions: InitiativeSubscription[] }
//   upsertSubscription     { subscriptionId?, initiativeId, kind, label,
//                            prompt?, config, enabled?, pollIntervalMs? }
//                        -> { subscription }
//   deleteSubscription     { subscriptionId }          -> { ok: true }
//   runSubscriptionNow     { subscriptionId }          -> { ok: true }
// ---------------------------------------------------------------------------

/** Agent tool names (globally unique, registered via bb.agents). */
export const INITIATIVE_TOOL_NAMES = {
  spawnAgent: "initiative_spawn_agent",
  listAgents: "initiative_list_agents",
  messageAgent: "initiative_message_agent",
  contextList: "initiative_context_list",
  contextRead: "initiative_context_read",
  contextWrite: "initiative_context_write",
  contextDelete: "initiative_context_delete",
  subscriptionList: "initiative_subscription_list",
  subscriptionUpsert: "initiative_subscription_upsert",
  subscriptionDelete: "initiative_subscription_delete",
} as const;
