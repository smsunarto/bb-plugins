// Which local annotations survive a reconcile. Getting this backwards either
// destroys feedback the human typed or resurrects feedback they deleted, and
// neither is visible until it happens to a real annotation.

import assert from "node:assert/strict";
import test from "node:test";

import { selectOrphans } from "../lib/annotation-hygiene.ts";

const local = (...ids: string[]) => ids.map((id) => ({ id }));
const ids = (items: { id: string }[]) => items.map((item) => item.id);

test("an annotation the server has never seen is kept", () => {
  // Typed, then the tab reloaded before the debounced push went out.
  const orphans = selectOrphans(local("a"), new Set(), new Set());
  assert.deepEqual(ids(orphans), ["a"]);
});

test("an annotation the server acknowledged and then lost is dropped", () => {
  // Deleted from the review panel: it was synced, and it is gone now.
  const orphans = selectOrphans(local("a"), new Set(), new Set(["a"]));
  assert.deepEqual(ids(orphans), []);
});

test("a resolved annotation is not mistaken for an unsent one", () => {
  // `knownToServer` carries the complete server list, resolved items included,
  // so resolving does not put the marker back on the page.
  const orphans = selectOrphans(local("a"), new Set(["a"]), new Set());
  assert.deepEqual(ids(orphans), []);
});

test("unsent and synced annotations are separated in one pass", () => {
  const orphans = selectOrphans(
    local("open", "resolved", "deleted", "unsent"),
    new Set(["open", "resolved"]),
    new Set(["open", "resolved", "deleted"]),
  );
  assert.deepEqual(ids(orphans), ["unsent"]);
});

test("a lost ledger keeps feedback rather than dropping it", () => {
  // Storage full or cleared: every local id looks unsent. The failure mode is
  // a resurrected annotation, never a destroyed one.
  const orphans = selectOrphans(local("a", "b"), new Set(), new Set());
  assert.deepEqual(ids(orphans), ["a", "b"]);
});

test("nothing local means nothing to recover", () => {
  assert.deepEqual(ids(selectOrphans([], new Set(["a"]), new Set(["a"]))), []);
});
