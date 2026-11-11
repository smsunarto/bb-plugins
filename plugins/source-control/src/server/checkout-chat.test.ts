import { expect, test } from "vitest";
import { createCheckoutChat } from "./checkout-chat.ts";
import type { Store } from "./store.ts";

const placement = {
  hostId: "host-b",
  hostName: "build-linux",
  path: "/home/scott/api",
  environmentId: "env_b",
};

function setup(overrides: { host?: object; environment?: object; threads?: object[] } = {}) {
  const store = { checkouts: () => [placement] } as unknown as Store;
  const bb = {
    sdk: {
      hosts: {
        get: async () => ({
          name: "build-linux",
          status: "connected",
          lifecycle: { phase: "active" },
          ...overrides.host,
        }),
      },
      environments: {
        get: async () => ({
          id: "env_b",
          projectId: "proj_1",
          hostId: "host-b",
          path: "/home/scott/api",
          status: "ready",
          lifecycle: { phase: "active" },
          hostLifecycle: "active",
          ...overrides.environment,
        }),
      },
      threads: {
        list: async () =>
          overrides.threads ?? [
            {
              id: "thr_hidden",
              environmentId: "env_b",
              archivedAt: null,
              deletedAt: null,
              visibility: "hidden",
            },
            {
              id: "thr_b",
              environmentId: "env_b",
              archivedAt: null,
              deletedAt: null,
              visibility: "visible",
            },
          ],
      },
    },
  } as never;
  return createCheckoutChat({ bb, store });
}

test("a ready checkout opens in a visible thread on its environment", async () => {
  expect(await setup()({ hostId: "host-b", path: "/home/scott/api" })).toEqual({
    state: "ready",
    projectId: "proj_1",
    environmentId: "env_b",
    hostId: "host-b",
    threadId: "thr_b",
  });
});

test("each reason there is nowhere to open is said, not guessed past", async () => {
  const at = { hostId: "host-b", path: "/home/scott/api" };
  expect(await setup()({ hostId: "host-b", path: "/elsewhere" })).toMatchObject({
    state: "unavailable",
  });
  expect(await setup({ host: { status: "disconnected" } })(at)).toEqual({
    state: "unavailable",
    reason: "build-linux must be connected before opening this checkout.",
  });
  expect(await setup({ environment: { status: "provisioning" } })(at)).toMatchObject({
    state: "unavailable",
  });
  expect(await setup({ threads: [] })(at)).toMatchObject({ state: "unavailable" });
});
