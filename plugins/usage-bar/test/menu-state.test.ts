import { expect, test } from "bun:test";
import { createMenuState } from "../src/server/lib/menu-state.ts";
import type { Source } from "../src/server/lib/sources.ts";
import type { AccountExtras } from "../src/server/lib/extras.ts";
function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const balance = (value: number): AccountExtras => ({
  resetCredits: null,
  extraUsage: { kind: "balance", balance: value },
});
function source(
  email: string,
  extras: (provider: "codex" | "claude", id: string, fresh?: boolean) => Promise<AccountExtras>,
  status: "ready" | "disabled" = "ready",
): Source {
  return {
    kind: "pool",
    extras: (fresh) => (provider, id) => extras(provider, id, fresh),
    providers: [
      {
        id: "codex",
        name: "Codex",
        accounts: [
          {
            id: "same-id",
            identity: email,
            plan: null,
            priority: 1,
            status,
            current: true,
            observedAt: 1,
            heldUntil: null,
            error: null,
            inFlight: 0,
            windows: [{ label: "Session", usedPercent: 25, resetAt: null, windowMinutes: 300 }],
          },
        ],
      },
    ],
  };
}
const shown = (state: ReturnType<typeof createMenuState>) =>
  state.snapshot().providers[0]!.accounts[0]!;

test("a synchronous batch factory failure clears extras and the next Refresh recovers", async () => {
  let failed = false;
  const current = source("a@example.com", async () => balance(7));
  const factory = current.extras;
  current.extras = (fresh) => {
    if (!failed) {
      failed = true;
      throw new Error("unavailable");
    }
    return factory(fresh);
  };
  const state = createMenuState(new AbortController().signal, () => {});
  state.setSource(current);
  await state.refresh(true);
  expect(shown(state)).toMatchObject({ identity: "a@example.com", extraUsage: null });
  await state.refresh(true);
  expect(shown(state).extraUsage).toEqual({ kind: "balance", balance: 7 });
});

test("Refresh starts a fresh pass at every background completion ordering", async () => {
  for (let ticks = 0; ticks < 12; ticks++) {
    const old = defer<AccountExtras>();
    const read = defer<Source>();
    const state = createMenuState(new AbortController().signal, () => {});
    state.setSource(source("a@example.com", () => old.promise));
    const background = state.refresh();
    const manual = state.publish(() => read.promise, true);
    old.resolve(balance(1));
    for (let i = 0; i < ticks; i++) await Promise.resolve();
    read.resolve(source("a@example.com", async (_p, _id, fresh) => balance(fresh ? 2 : 3)));
    await Promise.all([background, manual]);
    expect(shown(state).extraUsage).toEqual({ kind: "balance", balance: 2 });
  }
});

test("Refresh queued behind a background fetch waits for fresh extras", async () => {
  const first = defer<AccountExtras>();
  const second = defer<AccountExtras>();
  const state = createMenuState(new AbortController().signal, () => {});
  state.setSource(
    source("a@example.com", async (_p, _id, fresh) => (fresh ? second.promise : first.promise)),
  );
  const background = state.refresh();
  const manual = state.refresh(true);
  let done = false;
  void manual.then(() => {
    done = true;
    return null;
  });
  first.resolve(balance(1));
  await new Promise((resolve) => setImmediate(resolve));
  expect(shown(state).extraUsage).toEqual({ kind: "balance", balance: 1 });
  expect(done).toBe(false);
  second.resolve(balance(2));
  await Promise.all([background, manual]);
  expect(shown(state).extraUsage).toEqual({ kind: "balance", balance: 2 });
  expect(done).toBe(true);
});

test("account A to B to A rejects the old observation and fetches the new source", async () => {
  const old = defer<AccountExtras>();
  const current = defer<AccountExtras>();
  const seen: (number | null)[] = [];
  const state = createMenuState(new AbortController().signal, () => {
    const extra = state.snapshot().providers[0]?.accounts[0]?.extraUsage;
    seen.push(extra?.kind === "balance" ? extra.balance : null);
  });
  state.setSource(source("a@example.com", () => old.promise));
  const pending = state.refresh();
  state.setSource(source("b@example.com", async () => balance(2)));
  state.setSource(source("a@example.com", () => current.promise));
  old.resolve(balance(99));
  await new Promise((resolve) => setImmediate(resolve));
  expect(shown(state).extraUsage).toBeNull();
  expect(seen).not.toContain(99);
  current.resolve(balance(3));
  await pending;
  expect(shown(state).extraUsage).toEqual({ kind: "balance", balance: 3 });
});

test("disabled accounts and rejected extras clear old extras while global failure keeps quota", async () => {
  const state = createMenuState(new AbortController().signal, () => {});
  state.setSource(source("a@example.com", async () => balance(4)));
  await state.refresh();
  expect(shown(state).extraUsage).toEqual({ kind: "balance", balance: 4 });
  state.setSource(
    source("a@example.com", async () => {
      throw new Error("private token");
    }),
  );
  await state.refresh(true);
  expect(shown(state).extraUsage).toBeNull();
  state.failed();
  expect(state.snapshot().error).toBe("Usage unavailable. Check the provider in bb.");
  expect(shown(state).windows).toEqual([
    { label: "Session", usedPercent: 25, resetAt: null, windowMinutes: 300 },
  ]);
  state.setSource(source("a@example.com", async () => balance(9), "disabled"));
  await state.refresh(true);
  expect(shown(state)).toMatchObject({
    status: "disabled",
    extraUsage: null,
    webResetCredits: null,
  });
});

test("shutdown does not publish a late extras result", async () => {
  const abort = new AbortController();
  const deferred = defer<AccountExtras>();
  const state = createMenuState(abort.signal, () => {});
  state.setSource(source("a@example.com", () => deferred.promise));
  const pending = state.refresh();
  abort.abort();
  deferred.resolve(balance(8));
  await pending;
  expect(shown(state)).toMatchObject({ identity: "a@example.com", extraUsage: null });
});

test("menu opening cannot supersede a manual source refresh", async () => {
  const state = createMenuState(new AbortController().signal, () => {});
  state.setSource(source("a@example.com", async () => balance(1)));
  await state.refresh();
  const deferred = defer<Source>();
  const manual = state.publish(() => deferred.promise, true);
  const opening = state.publish(async () => source("b@example.com", async () => balance(99)));
  deferred.resolve(
    source("a@example.com", async (_provider, _id, fresh) => balance(fresh ? 5 : 1)),
  );
  await Promise.all([manual, opening]);
  expect(shown(state)).toMatchObject({
    identity: "a@example.com",
    extraUsage: { kind: "balance", balance: 5 },
  });
});
