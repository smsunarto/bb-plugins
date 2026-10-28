import { beforeEach, expect, test } from "bun:test";
import { queryClient } from "./query.ts";
import { installDom } from "@bb-plugins/testing";
import { parseWorkspace } from "../host/parse.ts";
import type { Workspace } from "../shared/schema.ts";
import { statusPayload } from "../../test/fixtures.ts";
import { rpcQueryKey } from "./rpc.ts";
import { readStored } from "./stored-queries.ts";

installDom();

const input = { threadId: "thread-1", repositoryKey: undefined };

// A new object each time: the store skips an answer it has already written.
function board(state: Workspace["state"] = "ready"): Workspace {
  return {
    ...parseWorkspace(statusPayload, "bb-plugins"),
    environmentId: "environment-1",
    state,
  };
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
  answer({ ...board("error"), reason: "The host did not answer." });
  expect(storedKeys()).toHaveLength(1);
  expect(readStored("workspace", input)).toEqual(ready);
});

test("a notice clears the stored board", () => {
  answer(board());
  answer({ ...board("noRepository"), stacks: [], base: null });
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
