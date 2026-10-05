import { expect, test } from "bun:test";
import { createMenuState } from "../src/server/lib/menu-state.ts";
import type { Source } from "../src/server/lib/sources.ts";
import { codexExtras, type ExtrasUpdate } from "../src/server/lib/extras.ts";
function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const balance = (value: number): ExtrasUpdate => ({
  resetCredits: null,
  extraUsage: { kind: "balance", balance: value },
});
function source(
  email: string,
  extras: (provider: "codex" | "claude", id: string, fresh?: boolean) => Promise<ExtrasUpdate>,
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
            status,
            current: true,
            lastUsedAt: null,
            observedAt: 1,
            heldUntil: null,
            error: null,
            inFlight: 0,
            windows: [
              { label: "Session", usedPercent: 25, resetAt: null, windowMinutes: 300, model: null },
            ],
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
    const old = defer<ExtrasUpdate>();
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
  const first = defer<ExtrasUpdate>();
  const second = defer<ExtrasUpdate>();
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
  const old = defer<ExtrasUpdate>();
  const current = defer<ExtrasUpdate>();
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
  expect(state.snapshot().error).toBe("Couldn't refresh usage. Showing the last reading.");
  expect(shown(state).windows).toEqual([
    { label: "Session", usedPercent: 25, resetAt: null, windowMinutes: 300, model: null },
  ]);
  state.setSource(source("a@example.com", async () => balance(9), "disabled"));
  await state.refresh(true);
  expect(shown(state)).toMatchObject({
    status: "disabled",
    extraUsage: null,
    webResetCredits: null,
  });
});

test("an update keeps every field it leaves unknown", async () => {
  let next: ExtrasUpdate = { ...balance(7), resetCredits: { expiries: [null] } };
  const state = createMenuState(new AbortController().signal, () => {});
  state.setSource(source("a@example.com", async () => next));
  await state.refresh(true);
  next = { extraUsage: null };
  await state.refresh(true);
  expect(shown(state)).toMatchObject({ resetCredits: { expiries: [null] }, extraUsage: null });
});

test("kept extras clear once 30 minutes pass with nothing known", async () => {
  let clock = 0;
  let next: ExtrasUpdate = balance(7);
  const state = createMenuState(
    new AbortController().signal,
    () => {},
    () => clock,
  );
  state.setSource(source("a@example.com", async () => next));
  await state.refresh(true);
  next = {};
  clock = 29 * 60_000;
  await state.refresh(true);
  expect(shown(state).extraUsage).toEqual({ kind: "balance", balance: 7 });
  clock = 30 * 60_000;
  await state.refresh(true);
  expect(shown(state)).toMatchObject({ resetCredits: null, extraUsage: null });
});

test("a throttled reset-credit request still shows the fetched balance on first load", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/wham/usage")
      ? Response.json({ credits: { has_credits: true, balance: 7 } })
      : Response.json({}, { status: 429 });
  try {
    const state = createMenuState(new AbortController().signal, () => {});
    state.setSource(source("a@example.com", () => codexExtras("fixture-token", null)));
    await state.refresh(true);
    expect(shown(state)).toMatchObject({
      resetCredits: null,
      extraUsage: { kind: "balance", balance: 7 },
    });
  } finally {
    globalThis.fetch = original;
  }
});

test("shutdown does not publish a late extras result", async () => {
  const abort = new AbortController();
  const deferred = defer<ExtrasUpdate>();
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
