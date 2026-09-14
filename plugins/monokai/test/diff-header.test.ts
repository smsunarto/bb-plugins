import { expect, test } from "bun:test";
import { readHeaderKind } from "../app/diff-header.ts";

function header(changeKind: unknown) {
  const root = { stateNode: { current: null as unknown }, return: null };
  root.stateNode.current = root;
  const fiber = {
    memoizedProps: { model: { path: "a.ts", label: "a.ts", changeKind } },
    return: root,
  };
  return {
    element: {
      __reactFiber$test: fiber,
      __reactProps$test: fiber.memoizedProps,
    } as unknown as Element,
    fiber,
    root,
  };
}

test("reads all native change kinds, including rename and copy", () => {
  for (const kind of ["added", "deleted", "modified", "renamed", "copied"]) {
    expect(readHeaderKind(header(kind).element)).toBe(kind);
  }
});

test("unknown or missing host contracts produce no icon", () => {
  expect(readHeaderKind(header("unrecognized").element)).toBeNull();
  expect(readHeaderKind(header("toString").element)).toBeNull();
  expect(readHeaderKind({} as Element)).toBeNull();
});

test("uses the committed alternate after React updates", () => {
  const stale = header("added");
  const current = header("deleted");
  stale.root.stateNode.current = current.root;
  Object.assign(stale.fiber, { alternate: current.fiber });
  Object.assign(stale.element, { __reactProps$test: current.fiber.memoizedProps });
  expect(readHeaderKind(stale.element)).toBe("deleted");
});

test("bounds traversal of an unexpected cyclic fiber", () => {
  const props = {};
  const fiber: Record<string, unknown> = { memoizedProps: props };
  fiber.return = fiber;
  expect(
    readHeaderKind({ __reactFiber$test: fiber, __reactProps$test: props } as unknown as Element),
  ).toBeNull();
});

test("reads mounted rows even when their parent tree points at the old root", () => {
  const fixture = header("modified");
  let parent: unknown = fixture.root;
  for (let depth = 0; depth < 150; depth++) parent = { return: parent };
  Object.assign(fixture.fiber, { return: parent });
  fixture.root.stateNode.current = {};
  expect(readHeaderKind(fixture.element)).toBe("modified");
});
