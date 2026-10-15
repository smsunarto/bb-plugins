import { expect } from "bun:test";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { Slot } from "./slot-store.ts";

export type Harness = ReturnType<typeof createFakePluginHost>["harness"];
const harnesses: Harness[] = [];
export async function cleanupSlots() {
  for (const harness of harnesses.splice(0)) await harness.lifecycle.dispose();
}

export function trackHarness(harness: Harness) {
  harnesses.push(harness);
}

const editor = {
  id: "main",
  projectPath: "/rampage",
  workspacePath: "/rampage",
  pid: 101,
  port: 7800,
  version: "6000.3.10f1",
  startedAt: "birth",
  clone: false,
};
export const project = {
  id: "project",
  name: "Rampage client",
  kind: "standard" as const,
  gitRemoteUrl: null,
  createdAt: 0,
  updatedAt: 0,
};
export const environment = makeMessageDispatchHookContext({
  environment: { id: "environment", hostId: "host", path: "/rampage", projectId: "project" },
}).environment!;

export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function setup(
  options: {
    environments?: (typeof environment)[];
    threads?: ReturnType<typeof makeThreadResponse>[];
    resolve?: (path: string) => string | null;
  } = {},
) {
  const state = {
    busy: false,
    editorVisible: false,
    archived: false,
    stopped: null as null | (() => Promise<void>),
    environments: options.environments ?? [],
    threads: options.threads ?? [],
    resolve: options.resolve ?? (() => "/rampage"),
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "unity",
    sdk: {
      plugins: { list: async () => ({ plugins: [] }) },
      projects: { get: async () => ({ ...project, sources: [] }) },
      threads: {
        list: async ({ environmentId, offset = 0, limit = 100 } = {}) =>
          state.threads
            .filter((thread) => thread.environmentId === environmentId)
            .slice(offset, offset + limit),
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "project",
            environmentId: "environment",
            archivedAt: threadId === "alice" && state.archived ? 1 : null,
          }),
      },
      environments: {
        list: async ({ offset = 0, limit = 100 } = {}) =>
          state.environments.slice(offset, offset + limit),
        get: async () => environment,
      },
    },
    experimental_callHostRpc: async ({ method, input }) => {
      if (method === "resolveWorkspace")
        return {
          workspacePath: state.resolve((input as { path: string }).path),
        };
      if (method === "inspectWorkspace")
        return { workspacePath: "/rampage", projectVersion: "6000.3.10f1" };
      if (method === "workspaceStopped") {
        await state.stopped?.();
        if (state.busy) throw new Error("Unity Editor is still running in this checkout");
        return { stopped: true };
      }
      if (method === "discover")
        return { instances: state.editorVisible ? [editor] : [], warnings: [] };
      if (method === "probe") return { pid: 101 };
      if (method === "quiet") return { quiet: true };
      if (method === "alive") return { alive: true };
      throw new Error(`Unexpected host method: ${method}`);
    },
  });
  harnesses.push(harness);
  await plugin(bb);
  const slot = await cliSlot(harness, [
    "slots",
    "register",
    "--host",
    "host",
    "--project",
    "project",
    "--path",
    "/rampage",
  ]);
  const provider = harness.registrations.environmentProviders.get("unity-rampage-slot")!;
  function provision(
    owner: string,
    pathKey = `launch-${owner}`,
  ): Parameters<typeof provider.create>[0] {
    return {
      project,
      host: makeHostResponse({ id: "host" }),
      projectCheckout: { path: "/rampage", experimental_ownsPath: false },
      gitRemote: null,
      inputs: { slotId: slot.id },
      thread: makeThreadResponse({ id: owner, projectId: "project", environmentId: "environment" }),
      suggestedBranchName: `scott/${owner}`,
      attempt: 1,
      pathKey,
      experimental_claimPath: async () => true,
      report: { step() {}, log() {} },
      signal: new AbortController().signal,
    };
  }
  return { state, harness, slot, provider, provision };
}

export async function cliSlot(harness: Harness, argv: string[], threadId?: string): Promise<Slot> {
  const result = await harness.behavior.runCli(argv, { threadId });
  expect(result).toMatchObject({ exitCode: 0 });
  return JSON.parse(result.stdout!);
}

export async function acquire(harness: Harness, id: string, owner = "alice") {
  return cliSlot(harness, ["slots", "acquire", "--host", "host", "--slot", id], owner);
}

export async function list(harness: Harness, threadId?: string): Promise<Slot[]> {
  const result = await harness.behavior.runCli(["slots", "list", "--host", "host"], { threadId });
  expect(result).toMatchObject({ exitCode: 0 });
  return JSON.parse(result.stdout!).slots;
}
