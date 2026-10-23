import { expect, test } from "bun:test";
import type { Rule, RulesState } from "../shared/rules.ts";
import { createRulesDraft } from "./draft.ts";

function rule(id: string): Rule {
  return {
    id,
    name: id,
    enabled: true,
    instructions: `${id}.`,
    when: { hosts: [], providers: [], models: [], projects: [] },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const names = (draft: ReturnType<typeof createRulesDraft>) =>
  draft.snapshot()?.draft.map((candidate) => candidate.id);

const settle = () => new Promise((done) => setTimeout(done, 5));

test("a newer revision fetched during a save is shown once the save lands", async () => {
  const reply = deferred<RulesState & { saved: boolean }>();
  const draft = createRulesDraft({ delayMs: 0, onStored: () => {} });
  draft.connect(() => reply.promise);
  draft.receive({ revision: 1, rules: [rule("a")] });
  const mine = [rule("mine")];
  draft.edit(mine);
  await settle();

  draft.receive({ revision: 3, rules: [rule("mine"), rule("cli")] });
  expect(names(draft)).toEqual(["mine"]);
  reply.resolve({ revision: 2, rules: mine, saved: true });
  await settle();

  expect(names(draft)).toEqual(["mine", "cli"]);
  expect(draft.snapshot()?.base.revision).toBe(3);
});

test("discarding my edits shows the newest stored rules", async () => {
  const draft = createRulesDraft({ delayMs: 0, onStored: () => {} });
  draft.connect(async () => ({ revision: 2, rules: [rule("cli")], saved: false }));
  draft.receive({ revision: 1, rules: [rule("a")] });
  draft.edit([rule("mine")]);
  await settle();
  expect(draft.snapshot()?.conflict?.revision).toBe(2);

  draft.receive({ revision: 3, rules: [rule("cli"), rule("later")] });
  draft.takeTheirs();
  expect(names(draft)).toEqual(["cli", "later"]);
});

test("an edit made while a failing save is in flight still saves", async () => {
  const failure = deferred<RulesState & { saved: boolean }>();
  const sent: string[][] = [];
  const draft = createRulesDraft({ delayMs: 0, onStored: () => {} });
  draft.connect(({ rules, revision }) => {
    sent.push(rules.map((candidate) => candidate.id));
    return sent.length === 1
      ? failure.promise
      : Promise.resolve({ revision: revision + 1, rules, saved: true });
  });
  draft.receive({ revision: 1, rules: [rule("a")] });
  draft.edit([rule("bad")]);
  await settle();
  draft.edit([rule("fixed")]);
  failure.reject(new Error("rpc input validation failed"));
  await settle();

  expect(sent).toEqual([["bad"], ["fixed"]]);
  expect(draft.snapshot()).toMatchObject({ error: null, base: { revision: 2 } });
});

test("reset cancels a scheduled save and accepts a fresh fixture", async () => {
  let calls = 0;
  const draft = createRulesDraft({ delayMs: 10, onStored: () => {} });
  draft.connect(async ({ rules, revision }) => {
    calls++;
    return { rules, revision: revision + 1, saved: true };
  });
  draft.receive({ revision: 9, rules: [rule("old")] });
  draft.edit([rule("unsaved")]);
  draft.resetForTest();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(calls).toBe(0);
  expect(draft.snapshot()).toBeNull();
  draft.receive({ revision: 1, rules: [rule("fresh")] });
  expect(names(draft)).toEqual(["fresh"]);
});

test.each(["success", "conflict", "failure"] as const)(
  "reset ignores an old in-flight %s without interrupting the new save",
  async (outcome) => {
    const old = deferred<RulesState & { saved: boolean }>();
    const fresh = deferred<RulesState & { saved: boolean }>();
    const stored: string[][] = [];
    const draft = createRulesDraft({
      delayMs: 0,
      onStored: (state) => stored.push(state.rules.map((item) => item.id)),
    });
    draft.connect(() => old.promise);
    draft.receive({ revision: 9, rules: [rule("old")] });
    draft.edit([rule("old-edit")]);
    await settle();

    draft.resetForTest();
    draft.connect(() => fresh.promise);
    draft.receive({ revision: 1, rules: [rule("fresh")] });
    draft.edit([rule("fresh-edit")]);
    await settle();

    if (outcome === "failure") old.reject(new Error("old host disconnected"));
    else old.resolve({ revision: 10, rules: [rule("old-edit")], saved: outcome === "success" });
    await settle();
    expect(names(draft)).toEqual(["fresh-edit"]);
    expect(draft.snapshot()).toMatchObject({ base: { revision: 1 }, conflict: null, error: null });
    expect(stored).toEqual([]);

    fresh.resolve({ revision: 2, rules: [rule("fresh-edit")], saved: true });
    await settle();
    expect(draft.snapshot()?.base.revision).toBe(2);
    expect(stored).toEqual([["fresh-edit"]]);
  },
);
