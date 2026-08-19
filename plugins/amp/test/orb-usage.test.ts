import assert from "node:assert/strict";
import test from "node:test";
import {
  findLatestProviderSessionId,
  isValidAmpThreadId,
  isValidProviderSessionId,
  MAX_AMP_THREAD_ID_LENGTH,
  MAX_PROVIDER_SESSION_ID_LENGTH,
  mergeOrbUsageRecord,
  parseOrbUsageRecord,
  toOrbUsageView,
  type OrbUsageRecord,
} from "../src/orb-usage.ts";

test("finds the latest provider identity without scanning unrelated events", async () => {
  const identities = [
    { providerSessionId: "S-first", seq: 3 },
    { providerSessionId: "S-current", seq: 901 },
  ];
  const requested: Array<string | undefined> = [];

  const latest = await findLatestProviderSessionId(async (afterSeq) => {
    requested.push(afterSeq);
    if (afterSeq === undefined) return identities[0];
    if (afterSeq === "3") return identities[1];
    return null;
  });

  assert.equal(latest, "S-current");
  assert.deepEqual(requested, [undefined, "3", "901"]);
});

test("provider identity lookup fails closed on malformed or nonadvancing rows", async () => {
  assert.equal(
    await findLatestProviderSessionId(async () => ({
      providerSessionId: "invalid/session",
      seq: 1,
    })),
    null,
  );

  let calls = 0;
  assert.equal(
    await findLatestProviderSessionId(async () => {
      calls += 1;
      return calls === 1
        ? { providerSessionId: "S-one", seq: 4 }
        : { providerSessionId: "S-two", seq: 4 };
    }),
    null,
  );
});

test("parses every valid durable state", () => {
  const records: OrbUsageRecord[] = [
    { providerSessionId: "session-1", state: "local" },
    { providerSessionId: "session:2", state: "orb-starting" },
    {
      providerSessionId: "session_3@example",
      state: "orb-active",
      ampThreadId: "T-01J8V3NF8B-X_y.z",
    },
  ];

  for (const record of records) {
    assert.deepEqual(parseOrbUsageRecord(JSON.parse(JSON.stringify(record))), record);
  }
});

test("strict parsing rejects malformed and non-exact records", () => {
  const malformed: unknown[] = [
    null,
    undefined,
    "orb-active",
    [],
    {},
    { providerSessionId: "session-1" },
    { state: "local" },
    { providerSessionId: "session-1", state: "unknown" },
    { providerSessionId: "session-1", state: "local", ampThreadId: "T-extra" },
    { providerSessionId: "session-1", state: "orb-starting", extra: true },
    { providerSessionId: "session-1", state: "orb-active" },
    { providerSessionId: "session-1", state: "orb-active", ampThreadId: 7 },
    {
      providerSessionId: "session-1",
      state: "orb-active",
      ampThreadId: "T-valid",
      extra: true,
    },
  ];

  for (const value of malformed) assert.equal(parseOrbUsageRecord(value), null);
});

test("provider session ids are nonempty, bounded, safe ASCII tokens", () => {
  assert.equal(isValidProviderSessionId("S-a1._:@+-"), true);
  assert.equal(isValidProviderSessionId("a".repeat(MAX_PROVIDER_SESSION_ID_LENGTH)), true);

  for (const value of [
    "",
    `a${"b".repeat(MAX_PROVIDER_SESSION_ID_LENGTH)}`,
    " session",
    "session with space",
    "session/path",
    "session\nnext",
    "session;rm",
    "session$(run)",
    "session`run`",
    "é",
  ]) {
    assert.equal(isValidProviderSessionId(value), false, JSON.stringify(value));
  }
});

test("Amp thread ids require T- and reject command injection", () => {
  assert.equal(isValidAmpThreadId("T-a"), true);
  assert.equal(isValidAmpThreadId("T-01J8V3NF8B-X_y.z"), true);
  assert.equal(isValidAmpThreadId(`T-${"a".repeat(MAX_AMP_THREAD_ID_LENGTH - 2)}`), true);

  for (const value of [
    "",
    "T-",
    "thread-1",
    `T-${"a".repeat(MAX_AMP_THREAD_ID_LENGTH - 1)}`,
    "T-safe; rm -rf x",
    "T-safe\nnext-command",
    "T-safe && run",
    "T-safe|run",
    "T-$(run)",
    "T-`run`",
    "T-safe/path",
    "T-é",
  ]) {
    assert.equal(isValidAmpThreadId(value), false, JSON.stringify(value));
    assert.equal(
      parseOrbUsageRecord({
        providerSessionId: "session-1",
        state: "orb-active",
        ampThreadId: value,
      }),
      null,
    );
  }
});

test("same provider session cannot downgrade active Orb usage to starting", () => {
  const active: OrbUsageRecord = {
    providerSessionId: "session-1",
    state: "orb-active",
    ampThreadId: "T-active",
  };
  const starting: OrbUsageRecord = {
    providerSessionId: "session-1",
    state: "orb-starting",
  };

  assert.equal(mergeOrbUsageRecord(active, starting), active);
  assert.deepEqual(mergeOrbUsageRecord(starting, active), active);
});

test("a different provider session can replace an active record", () => {
  const active: OrbUsageRecord = {
    providerSessionId: "session-old",
    state: "orb-active",
    ampThreadId: "T-old",
  };
  const replacement: OrbUsageRecord = {
    providerSessionId: "session-new",
    state: "orb-starting",
  };

  assert.equal(mergeOrbUsageRecord(active, replacement), replacement);
});

test("maps durable states to the UI union and emits an exact safe sync command", () => {
  assert.deepEqual(toOrbUsageView(null), { state: "hidden" });
  assert.deepEqual(
    toOrbUsageView({
      providerSessionId: "session-local",
      state: "local",
    }),
    { state: "hidden" },
  );
  assert.deepEqual(
    toOrbUsageView({
      providerSessionId: "session-starting",
      state: "orb-starting",
    }),
    { state: "starting" },
  );
  assert.deepEqual(
    toOrbUsageView({
      providerSessionId: "session-active",
      state: "orb-active",
      ampThreadId: "T-actual_123",
    }),
    {
      state: "active",
      ampThreadId: "T-actual_123",
      syncCommand: "amp sync T-actual_123",
    },
  );
});
