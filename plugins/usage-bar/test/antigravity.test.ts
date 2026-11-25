import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AntigravityProbe,
  createAntigravityReader,
  parseAntigravityUsage,
  probeAntigravity,
  supportedVersion,
} from "../src/server/lib/antigravity.ts";
import { NO_EXTRAS } from "../src/server/lib/extras.ts";
import { createMenuState } from "../src/server/lib/menu-state.ts";
import type { Source } from "../src/server/lib/sources.ts";
import recorded from "./fixtures/antigravity-usage.json";

const signal = new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The recorded payload with one group's limits partly used and exhausted. */
function used(): unknown {
  const body = structuredClone(recorded) as typeof recorded;
  const [gemini, thirdParty] = body.command.data.groups;
  gemini!.buckets[0]!.remaining_fraction = 0.375;
  // agy omits a zero remaining_fraction (`omitempty`): this bucket is exhausted.
  delete (thirdParty!.buckets[0] as { remaining_fraction?: number }).remaining_fraction;
  return body;
}

test("the recorded /usage payload maps to one window per limit, session first", () => {
  const parsed = parseAntigravityUsage(recorded);
  expect(parsed).toStrictEqual({
    kind: "ok",
    windows: [
      {
        label: "Gemini session",
        usedPercent: 0,
        resetAt: Date.parse("2026-11-26T02:46:09Z"),
        windowMinutes: 300,
        model: null,
      },
      {
        label: "Gemini weekly",
        usedPercent: 0,
        resetAt: Date.parse("2026-12-02T21:46:09Z"),
        windowMinutes: 10080,
        model: null,
      },
      // A full limit with no scheduled reset reports the Unix epoch.
      {
        label: "Claude/GPT session",
        usedPercent: 0,
        resetAt: null,
        windowMinutes: 300,
        model: null,
      },
      {
        label: "Claude/GPT weekly",
        usedPercent: 0,
        resetAt: null,
        windowMinutes: 10080,
        model: null,
      },
    ],
  });
});

test("used and exhausted limits read as used; unknown windows keep their name", () => {
  const body = used() as typeof recorded;
  body.command.data.groups[0]!.buckets.push({
    id: "gemini-monthly",
    name: "Monthly Limit Remaining",
    window: "monthly",
    remaining_fraction: 0.5,
    reset_time: "2026-12-25T00:00:00Z",
  });
  const parsed = parseAntigravityUsage(body);
  if (parsed.kind !== "ok") throw new Error(parsed.kind);
  expect(
    parsed.windows.map(({ label, usedPercent, windowMinutes }) => ({
      label,
      usedPercent,
      windowMinutes,
    })),
  ).toStrictEqual([
    { label: "Gemini session", usedPercent: 0, windowMinutes: 300 },
    { label: "Gemini weekly", usedPercent: 62.5, windowMinutes: 10080 },
    { label: "Gemini Monthly Limit Remaining", usedPercent: 50, windowMinutes: null },
    { label: "Claude/GPT session", usedPercent: 0, windowMinutes: 300 },
    { label: "Claude/GPT weekly", usedPercent: 100, windowMinutes: 10080 },
  ]);
});

test("a run that was not the /usage command is unsafe; a malformed one only failed", () => {
  // What an older agy prints when "/usage" reaches the model as a prompt.
  const turn = {
    conversation_id: "conversation",
    status: "SUCCESS",
    response: "I can't check quota from inside a turn.",
    num_turns: 1,
  };
  expect(parseAntigravityUsage(turn).kind).toBe("unsafe");
  expect(parseAntigravityUsage({ ...turn, conversation_id: "", num_turns: 0 }).kind).toBe("unsafe");
  expect(
    parseAntigravityUsage({ ...(recorded as object), command: { name: "model", data: {} } }).kind,
  ).toBe("unsafe");
  expect(
    parseAntigravityUsage({ status: "ERROR", error: "authentication failed or timed out" }).kind,
  ).toBe("failed");
  expect(parseAntigravityUsage(null).kind).toBe("failed");
  expect(
    parseAntigravityUsage({ ...(recorded as object), command: { name: "usage", data: 1 } }).kind,
  ).toBe("failed");
});

test("only agy 1.1.12 and later is asked for /usage", () => {
  expect(supportedVersion("1.5.17\n")).toBe(true);
  expect(supportedVersion("1.1.12")).toBe(true);
  expect(supportedVersion("2.0.0")).toBe(true);
  expect(supportedVersion("1.1.11")).toBe(false);
  expect(supportedVersion("0.9.99")).toBe(false);
  expect(supportedVersion("dev")).toBe(false);
});

function scripted(results: AntigravityProbe[]) {
  let calls = 0;
  let clock = 0;
  const probe = async () => {
    calls += 1;
    return results.shift() ?? { status: "failed" as const };
  };
  return {
    probe,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    get calls() {
      return calls;
    },
  };
}

test("absent or signed-out Antigravity shows no provider", async () => {
  for (const status of ["absent", "signed-out"] as const) {
    const fake = scripted([{ status }]);
    const read = createAntigravityReader(fake.probe, fake.now);
    expect(await read(signal, true)).toBeNull();
    expect(await read(signal, false)).toBeNull();
    expect(fake.calls).toBe(1);
  }
});

test("a reading lasts 5 minutes; a failure keeps it; signing out removes it", async () => {
  const fake = scripted([
    { status: "ok", body: recorded },
    { status: "failed" },
    { status: "signed-out" },
  ]);
  const read = createAntigravityReader(fake.probe, fake.now);
  const first = await read(signal, true);
  expect(first).toMatchObject({
    id: "antigravity",
    name: "Antigravity",
    accounts: [{ id: "antigravity", plan: null, current: true, status: "ready", observedAt: 0 }],
  });
  fake.advance(299_999);
  expect(await read(signal, false)).toBe(first);
  expect(fake.calls).toBe(1);
  // A failed read keeps the reading, marked stale.
  const stale = await read(signal, true);
  expect(stale).toStrictEqual({
    ...first!,
    error: "Couldn't refresh Antigravity. Showing the last reading.",
  });
  fake.advance(300_000);
  expect(await read(signal, false)).toBe(stale);
  await tick();
  expect(fake.calls).toBe(3);
  expect(await read(signal, false)).toBeNull();
});

test("repeated failures keep one stale reading, and the next good read clears it", async () => {
  const fake = scripted([
    { status: "ok", body: recorded },
    { status: "failed" },
    { status: "ok", body: { status: "SUCCESS", command: { name: "usage", data: 1 } } },
    { status: "ok", body: recorded },
  ]);
  const read = createAntigravityReader(fake.probe, fake.now);
  await read(signal, true);
  const stale = await read(signal, true);
  expect(stale?.error).toBe("Couldn't refresh Antigravity. Showing the last reading.");
  // A malformed answer is a failure too, and the same object means no redraw.
  expect(await read(signal, true)).toBe(stale);
  expect((await read(signal, true))?.error).toBeUndefined();
});

test("a poll answers from the last reading while the CLI is still running", async () => {
  let finish: (result: AntigravityProbe) => void = () => {};
  let calls = 0;
  const read = createAntigravityReader(() => {
    calls += 1;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  expect(await read(signal, false)).toBeNull();
  expect(await read(signal, false)).toBeNull();
  expect(calls).toBe(1);
  finish({ status: "ok", body: recorded });
  await tick();
  expect((await read(signal, false))?.id).toBe("antigravity");
});

test("an unsafe answer turns the reader off for good", async () => {
  const warnings: string[] = [];
  const fake = scripted([
    { status: "ok", body: recorded },
    { status: "ok", body: { conversation_id: "c", status: "SUCCESS", num_turns: 1 } },
    { status: "ok", body: recorded },
  ]);
  const read = createAntigravityReader(fake.probe, fake.now, (message) => warnings.push(message));
  expect(await read(signal, true)).not.toBeNull();
  expect(await read(signal, true)).toBeNull();
  fake.advance(3_600_000);
  expect(await read(signal, true)).toBeNull();
  expect(await read(signal, false)).toBeNull();
  expect(fake.calls).toBe(2);
  expect(warnings).toHaveLength(1);
});

/** A one-account Codex source whose extras reader records what it was asked. */
function codexSource(asked: string[]): Source {
  return {
    kind: "builtin",
    providers: [
      {
        id: "codex",
        name: "Codex",
        accounts: [
          {
            id: "codex-account",
            identity: "Codex",
            plan: null,
            status: "ready",
            current: true,
            lastUsedAt: null,
            observedAt: 1,
            heldUntil: null,
            error: null,
            inFlight: 0,
            windows: [],
          },
        ],
      },
    ],
    extras: () => async (provider) => {
      asked.push(provider);
      return { extraUsage: { kind: "balance", balance: 5 } };
    },
  };
}

test("without Antigravity, the Codex and Claude snapshot is unchanged", async () => {
  const state = createMenuState(signal, () => {});
  state.setSource(codexSource([]));
  await state.refresh(true);
  const before = state.snapshot();
  for (const status of ["absent", "signed-out"] as const) {
    const read = createAntigravityReader(async () => ({ status }));
    state.setAntigravity(await read(signal, true));
    expect(state.snapshot()).toStrictEqual(before);
  }
  const broken = createAntigravityReader(async () => {
    throw new Error("agy crashed");
  });
  state.setAntigravity(await broken(signal, true));
  expect(state.snapshot()).toStrictEqual(before);
});

test("Antigravity follows Codex and Claude, survives their failure, and never resets extras", async () => {
  const asked: string[] = [];
  let changes = 0;
  const state = createMenuState(signal, () => {
    changes += 1;
  });
  const read = createAntigravityReader(async () => ({ status: "ok", body: recorded }));
  const antigravity = await read(signal, true);
  // Before Codex or Claude has ever been read, Antigravity still shows.
  state.setAntigravity(antigravity);
  expect(state.snapshot().providers.map((provider) => provider.id)).toStrictEqual(["antigravity"]);

  state.setSource(codexSource(asked));
  await state.refresh(true);
  expect(state.snapshot().providers.map((provider) => provider.id)).toStrictEqual([
    "codex",
    "antigravity",
  ]);
  expect(asked).toStrictEqual(["codex"]);
  expect(state.snapshot().providers[1]?.accounts[0]).toMatchObject(NO_EXTRAS);

  // Antigravity coming and going leaves Codex's extras alone.
  state.setAntigravity(null);
  state.setAntigravity(antigravity);
  expect(state.snapshot().providers[0]?.accounts[0]?.extraUsage).toStrictEqual({
    kind: "balance",
    balance: 5,
  });

  // A failed Codex and Claude read keeps Antigravity, and only they show as stale.
  state.failed();
  expect(
    state.snapshot().providers.map(({ id, error }) => ({ id, stale: error !== null })),
  ).toStrictEqual([
    { id: "codex", stale: true },
    { id: "antigravity", stale: false },
  ]);

  // A stale Antigravity reading is labelled on its own provider only.
  state.setAntigravity({ ...antigravity!, error: "stale" });
  expect(state.snapshot().providers.map(({ error }) => error)).toStrictEqual([
    "Couldn't refresh usage. Showing the last reading.",
    "stale",
  ]);
  state.setAntigravity(antigravity);

  // An unchanged reading does not redraw.
  const before = changes;
  state.setAntigravity(antigravity);
  expect(changes).toBe(before);
});

agyProbeTests();

/** probeAntigravity against fake `agy` scripts, never the machine's real one. */
function agyProbeTests() {
  let dir = "";
  let agy = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "usage-bar-agy-"));
    agy = join(dir, "agy");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const fakeAgy = async (body: string) => {
    await writeFile(agy, `#!/bin/sh\n${body}\n`);
    await chmod(agy, 0o755);
  };
  const probe = () => probeAntigravity(signal, () => agy);

  test("probe: a supported agy answers /usage with JSON and no stray flags", async () => {
    await writeFile(join(dir, "usage.json"), JSON.stringify(recorded));
    await fakeAgy(`
if [ "$1" = "--version" ]; then echo 1.5.17; exit 0; fi
[ "$AGY_CLI_DISABLE_AUTO_UPDATE" = 1 ] || exit 9
case "$(command -v open):$(command -v xdg-open)" in *bb-usage-bar-agy-*/open:*bb-usage-bar-agy-*/xdg-open) ;; *) exit 7 ;; esac
open "https://accounts.google.com/o/oauth2/auth" || exit 6
[ -z "$SSH_CONNECTION" ] || exit 5
[ "$*" = "-p /usage --output-format json --log-file /dev/null" ] || exit 8
cat "${dir}/usage.json"`);
    expect(await probe()).toStrictEqual({ status: "ok", body: recorded });
  });

  test("probe: an old agy is never asked for /usage", async () => {
    await fakeAgy(`
if [ "$1" = "--version" ]; then echo 1.1.10; exit 0; fi
touch "${dir}/prompted"`);
    expect(await probe()).toStrictEqual({ status: "absent" });
    expect(existsSync(join(dir, "prompted"))).toBe(false);
  });

  test("probe: no agy at all is absent", async () => {
    expect(await probeAntigravity(signal, () => null)).toStrictEqual({ status: "absent" });
  });

  test("probe: a signed-out agy is stopped as soon as it asks for a sign-in", async () => {
    await fakeAgy(`
if [ "$1" = "--version" ]; then echo 1.5.17; exit 0; fi
echo "Authentication required. Please visit the URL to log in:" >&2
echo "  https://accounts.google.com/o/oauth2/auth?state=secret" >&2
exec sleep 30`);
    const started = Date.now();
    expect(await probe()).toStrictEqual({ status: "signed-out" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("probe: an API-key sign-in with no account quota is absent", async () => {
    await fakeAgy(`
if [ "$1" = "--version" ]; then echo 1.5.17; exit 0; fi
exit 2`);
    expect(await probe()).toStrictEqual({ status: "absent" });
  });
}
