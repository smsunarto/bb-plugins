import { beforeEach, expect, test } from "bun:test";
import { queryClient } from "./query.ts";
import { installDom } from "@bb-plugins/testing";
import { parseWorkspace } from "../host/parse.ts";
import type { ReadyWorkspace, Workspace } from "../shared/schema.ts";
import { statusPayload } from "../../test/fixtures.ts";
import { rpcQueryKey } from "./rpc.ts";
import { readStored } from "./stored-queries.ts";

installDom();

const input = { threadId: "thread-1", repositoryKey: undefined };

// A new object each time: the store skips an answer it has already written.
function board(): ReadyWorkspace {
  return {
    state: "ready",
    ...parseWorkspace(statusPayload),
    repositoryKey: ".",
    repoName: "bb-plugins",
    environmentId: "environment-1",
    hostId: "host-1",
    checkoutIdentity: {
      path: "/work/bb-plugins",
      branch: "gitbutler/workspace",
      head: "a".repeat(40),
      origin: "github.com/scott/bb-plugins",
      commonDir: "/work/bb-plugins/.git",
      kind: "gitbutler",
    },
    nativeAgentPrompts: null,
  };
}

/** The answer a read that found no board gives. */
function unavailable(state: Exclude<Workspace["state"], "ready">, reason: string): Workspace {
  return { state, reason, environmentId: "environment-1", repositoryKey: null };
}

function answer(data: Workspace): void {
  queryClient.setQueryData(rpcQueryKey("workspace", input), data);
}

/** The stored entries' keys, without the index. */
function storedKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith("bb-plugin-gitbutler:query:") && !key.endsWith(":index")) keys.push(key);
  }
  return keys;
}

beforeEach(() => {
  queryClient.clear();
  window.localStorage.clear();
});

test("a board that read cleanly is stored", () => {
  const ready = board();
  answer(ready);
  expect(storedKeys()).toHaveLength(1);
  expect(readStored("workspace", input)).toEqual(ready);
});

test("a failed read leaves the stored board in place", () => {
  const ready = board();
  answer(ready);
  answer(unavailable("error", "The host did not answer."));
  expect(storedKeys()).toHaveLength(1);
  expect(readStored("workspace", input)).toEqual(ready);
});

test("a notice clears the stored board", () => {
  answer(board());
  answer(unavailable("noRepository", "No repository in this environment."));
  expect(storedKeys()).toEqual([]);
  expect(readStored("workspace", input)).toBeUndefined();
});

test("a stored board that no longer fits the schema is dropped", () => {
  answer(board());
  const [key] = storedKeys();
  window.localStorage.setItem(key!, JSON.stringify({ at: 1, data: { state: "ready" } }));
  expect(readStored("workspace", input)).toBeUndefined();
  expect(window.localStorage.getItem(key!)).toBeNull();
});

test("a board stored by a build that zero-filled its notices is dropped", () => {
  answer(board());
  const [key] = storedKeys();
  // Before a board and a notice were told apart, a stored board carried a
  // `reason` and could lack its checkout, machine, and prompts.
  const older = {
    ...board(),
    reason: null,
    checkoutIdentity: undefined,
    hostId: undefined,
    nativeAgentPrompts: undefined,
  };
  window.localStorage.setItem(key!, JSON.stringify({ at: 1, data: older }));
  expect(readStored("workspace", input)).toBeUndefined();
  expect(window.localStorage.getItem(key!)).toBeNull();
});

test("storage that refuses every write never fails the read", () => {
  const proto = Object.getPrototypeOf(window.localStorage) as Storage;
  const setItem = proto.setItem;
  proto.setItem = () => {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
  try {
    const ready = board();
    expect(() => answer(ready)).not.toThrow();
    expect(queryClient.getQueryData<unknown>(rpcQueryKey("workspace", input))).toBe(ready);
  } finally {
    proto.setItem = setItem;
  }
});
