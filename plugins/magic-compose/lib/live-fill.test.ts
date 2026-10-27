import { describe, expect, it } from "vitest";
import {
  createLiveFill,
  FIRST_DELAY_MS,
  PAUSE_MS,
  ROUND_TIMEOUT_MS,
  THROTTLE_MS,
} from "./live-fill";

/** A clock the test moves by hand, and a Jev whose answers the test releases. */
function harness() {
  let now = 0;
  let nextTimer = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const routes: {
    text: string;
    at: number;
    resolve(value: string): void;
    reject(error: Error): void;
  }[] = [];
  const applied: { selection: string; previous: string | null }[] = [];
  let applyGate: Promise<void> = Promise.resolve();

  const live = createLiveFill<string>({
    route: (text) =>
      new Promise<string>((resolve, reject) => {
        routes.push({ text, at: now, resolve, reject });
      }),
    apply: async (selection, previous) => {
      await applyGate;
      applied.push({ selection, previous });
    },
    now: () => now,
    setTimer: (run, ms) => {
      const id = nextTimer++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return {
    live,
    routes,
    applied,
    holdApply() {
      let release = () => {};
      applyGate = new Promise((resolve) => {
        release = resolve;
      });
      return release;
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await flush();
      }
      now = until;
      await flush();
    },
    flush,
  };
}

describe("createLiveFill", () => {
  it("does nothing while Magic Compose is off", async () => {
    const h = harness();
    h.live.setText("fix the bug");
    await h.advance(5_000);
    expect(h.routes).toHaveLength(0);
    expect(h.live.getSnapshot()).toEqual({ enabled: false, pending: false, error: null });
  });

  it("holds the draft from the first keystroke until its selection is applied", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("fix the bug");
    expect(h.live.getSnapshot().pending).toBe(true);

    await h.advance(FIRST_DELAY_MS);
    expect(h.routes.map((route) => route.text)).toEqual(["fix the bug"]);
    expect(h.live.getSnapshot().pending).toBe(true);

    const release = h.holdApply();
    h.routes[0]?.resolve("codex");
    await h.flush();
    // Routed, but the composer has not taken it yet.
    expect(h.live.getSnapshot().pending).toBe(true);

    release();
    await h.flush();
    expect(h.applied).toEqual([{ selection: "codex", previous: null }]);
    expect(h.live.getSnapshot().pending).toBe(false);
  });

  it("does not route a draft that is empty or only spaces", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("   ");
    await h.advance(5_000);
    expect(h.routes).toHaveLength(0);
    expect(h.live.getSnapshot().pending).toBe(false);
  });

  it("throttles while typing, keeps one request in the air, and ends on the final text", async () => {
    const h = harness();
    h.live.setEnabled(true);
    // A keystroke every 100ms for two seconds, answered by a Jev that takes 250ms.
    let answered = 0;
    for (let i = 1; i <= 20; i++) {
      h.live.setText("x".repeat(i));
      await h.advance(100);
      while (
        answered < h.routes.length &&
        i * 100 >= answered * THROTTLE_MS + FIRST_DELAY_MS + 250
      ) {
        h.routes[answered]?.resolve(`selection ${answered}`);
        answered += 1;
        await h.flush();
      }
    }
    // Far fewer requests than keystrokes, none closer together than the throttle.
    expect(h.routes.length).toBeLessThanOrEqual(4);
    expect(h.routes[0]?.at).toBe(FIRST_DELAY_MS);
    for (let i = 1; i < h.routes.length; i++) {
      expect((h.routes[i]?.at ?? 0) - (h.routes[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
        THROTTLE_MS,
      );
    }
    expect(h.live.getSnapshot().pending).toBe(true);

    // Typing stops: whatever is out lands, and one last round takes the final text.
    for (let i = 0; i < 5; i++) {
      h.routes[answered]?.resolve(`selection ${answered}`);
      if (h.routes[answered] !== undefined) answered += 1;
      await h.advance(THROTTLE_MS);
    }
    expect(h.routes.at(-1)?.text).toBe("x".repeat(20));
    expect(h.live.getSnapshot().pending).toBe(false);
    // Each apply was told what the composer held before it.
    expect(h.applied.map((entry) => entry.previous)).toEqual([
      null,
      ...h.applied.slice(0, -1).map((entry) => entry.selection),
    ]);
  });

  it("waits for typing to stop when the pace is pause, and still holds the draft", async () => {
    const h = harness();
    h.live.setPace("pause");
    h.live.setEnabled(true);
    // Three seconds of typing: nothing is sent while it goes on.
    for (let i = 1; i <= 30; i++) {
      h.live.setText("x".repeat(i));
      await h.advance(100);
      expect(h.routes).toHaveLength(0);
      expect(h.live.getSnapshot().pending).toBe(true);
    }
    await h.advance(PAUSE_MS);
    expect(h.routes.map((route) => route.text)).toEqual(["x".repeat(30)]);
    h.routes[0]?.resolve("codex");
    await h.flush();
    expect(h.live.getSnapshot().pending).toBe(false);
  });

  it("lets the draft go when a round fails, and tries again once it changes", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("fix the bug");
    await h.advance(FIRST_DELAY_MS);
    h.routes[0]?.reject(new Error("Add an OpenRouter API key."));
    await h.flush();
    expect(h.live.getSnapshot()).toEqual({
      enabled: true,
      pending: false,
      error: "Add an OpenRouter API key.",
    });

    // The same text is not hammered against a broken connection.
    await h.advance(10_000);
    expect(h.routes).toHaveLength(1);

    h.live.setText("fix the bug now");
    expect(h.live.getSnapshot()).toEqual({ enabled: true, pending: true, error: null });
    await h.advance(THROTTLE_MS);
    expect(h.routes.map((route) => route.text)).toEqual(["fix the bug", "fix the bug now"]);
  });

  it("tries the same draft again when asked to", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("fix the bug");
    await h.advance(FIRST_DELAY_MS);
    h.routes[0]?.reject(new Error("offline"));
    await h.flush();

    h.live.retry();
    expect(h.live.getSnapshot()).toEqual({ enabled: true, pending: true, error: null });
    await h.advance(THROTTLE_MS);
    h.routes[1]?.resolve("codex");
    await h.flush();
    expect(h.live.getSnapshot().pending).toBe(false);
  });

  it("gives up on a round that never answers, so send is not held for good", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("fix the bug");
    await h.advance(FIRST_DELAY_MS + ROUND_TIMEOUT_MS);
    expect(h.live.getSnapshot()).toEqual({
      enabled: true,
      pending: false,
      error: "Magic Compose took too long to decide.",
    });
    // The answer that finally comes is no longer wanted.
    h.routes[0]?.resolve("late");
    await h.flush();
    expect(h.applied).toEqual([]);
  });

  it("drops a round in the air when Magic Compose is switched off", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("fix the bug");
    await h.advance(FIRST_DELAY_MS);
    h.live.setEnabled(false);
    h.routes[0]?.resolve("codex");
    await h.flush();
    expect(h.applied).toEqual([]);
    expect(h.live.getSnapshot()).toEqual({ enabled: false, pending: false, error: null });
  });

  it("decides the draft afresh when Magic Compose comes back on", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("fix the bug");
    await h.advance(FIRST_DELAY_MS);
    h.routes[0]?.resolve("codex");
    await h.flush();
    expect(h.live.getSnapshot().pending).toBe(false);

    h.live.setEnabled(false);
    h.live.setEnabled(true);
    expect(h.live.getSnapshot().pending).toBe(true);
    await h.advance(THROTTLE_MS);
    h.routes[1]?.resolve("codex");
    await h.flush();
    // Nothing is assumed about what the composer holds after being off.
    expect(h.applied.at(-1)).toEqual({ selection: "codex", previous: null });
  });

  it("decides afresh on reset, without going off in between", async () => {
    const h = harness();
    h.live.setEnabled(true);
    h.live.setText("fix the bug");
    await h.advance(FIRST_DELAY_MS);
    h.routes[0]?.resolve("codex");
    await h.flush();
    expect(h.live.getSnapshot().pending).toBe(false);

    h.live.reset();
    expect(h.live.getSnapshot()).toEqual({ enabled: true, pending: true, error: null });
    await h.advance(THROTTLE_MS);
    h.routes[1]?.resolve("codex");
    await h.flush();
    expect(h.applied.at(-1)).toEqual({ selection: "codex", previous: null });
  });

  it("tells subscribers only when something they can see changed", async () => {
    const h = harness();
    let calls = 0;
    h.live.subscribe(() => {
      calls += 1;
    });
    h.live.setEnabled(true);
    h.live.setText("a");
    h.live.setText("ab");
    h.live.setText("abc");
    // On, then pending: the two later keystrokes changed nothing visible.
    expect(calls).toBe(2);
  });
});
