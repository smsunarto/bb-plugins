import { afterEach, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setImmediate as settle } from "node:timers/promises";
import type { ToolbarView } from "../lib/toolbar.ts";
import type { AgentationProps, Annotation } from "../vendor/agentation/dist/index.mjs";

type Timer = { at: number; interval: number; callback: () => void };
type SessionSnapshot = {
  session: { id: string };
  annotations: Annotation[];
  cursor: number;
  config: { toolbarEnabled: boolean };
};

// Bun module mocks survive mock.restore(). Isolate the vendor storage and RPC fakes.
if (!process.env.BB_AGENTATION_LIFECYCLE_CHILD) {
  test("toolbar lifecycle contract", () => {
    const child = spawnSync(process.execPath, ["test", fileURLToPath(import.meta.url)], {
      env: { ...process.env, BB_AGENTATION_LIFECYCLE_CHILD: "1" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
  });
} else {
  let active: ReturnType<typeof harness>;
  const originals = new Map<string, PropertyDescriptor | undefined>();

  function replaceGlobal(name: string, value: unknown): void {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  function harness() {
    let time = 0;
    let nextTimer = 0;
    let view: AgentationProps | null = null;
    const timers = new Map<number, Timer>();
    const storage = new Map<string, string>();
    const annotations = new Map<string, Annotation[]>();
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const streams = new Set<FakeEventSource>();
    const location = { pathname: "/a", href: "https://bb.test/a" };
    const snapshot = (route: string): SessionSnapshot => ({
      session: { id: `session:${route}` },
      annotations: annotations.get(route) ?? [],
      cursor: 1,
      config: { toolbarEnabled: true },
    });
    let opening: Promise<SessionSnapshot> | null = null;
    const call = mock(async (method: string, input: Record<string, unknown>) => {
      const route = String(input.sessionId ?? "").replace("session:", "");
      if (method === "openSession") return opening ?? snapshot(String(input.route));
      if (method === "pushAnnotations") {
        const upserts = input.upserts as { annotation: Annotation }[];
        annotations.set(
          route,
          upserts.map((item) => item.annotation),
        );
        return { cursor: 1 };
      }
      if (method === "pullSession") return { ...snapshot(route), changed: false };
      throw new Error(`Unexpected RPC ${method}`);
    });
    class FakeEventSource extends EventTarget {
      constructor() {
        super();
        streams.add(this);
      }
      close() {
        streams.delete(this);
      }
    }
    const document = {
      title: "Test page",
      hidden: false,
      documentElement: { classList: { contains: () => false } },
      querySelectorAll: () => [],
      addEventListener: (
        _name: string,
        listener: EventListenerOrEventListenerObject,
        options: AddEventListenerOptions,
      ) => {
        if (options.signal?.aborted) return;
        listeners.add(listener);
        options.signal?.addEventListener("abort", () => listeners.delete(listener), { once: true });
      },
    };
    const addTimer = (callback: () => void, delay = 0, interval = 0) => {
      const id = ++nextTimer;
      timers.set(id, { at: time + delay, interval, callback });
      return id;
    };
    replaceGlobal("document", document);
    replaceGlobal("window", { location });
    replaceGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    replaceGlobal("EventSource", FakeEventSource);
    replaceGlobal("setTimeout", addTimer);
    replaceGlobal("setInterval", (callback: () => void, delay: number) =>
      addTimer(callback, delay, delay),
    );
    replaceGlobal("clearTimeout", timers.delete.bind(timers));
    replaceGlobal("clearInterval", timers.delete.bind(timers));
    replaceGlobal("requestAnimationFrame", addTimer);
    replaceGlobal("cancelAnimationFrame", timers.delete.bind(timers));
    return {
      annotations,
      listeners,
      streams,
      timers,
      call,
      setView: mock((snapshot: ToolbarView) => {
        view = snapshot?.props ?? null;
      }),
      view: () => view,
      navigate: (route: string) => {
        location.pathname = route;
        location.href = `https://bb.test${route}`;
      },
      holdInitialSession: () => {
        let resolve!: (value: SessionSnapshot) => void;
        opening = new Promise<SessionSnapshot>((release) => {
          resolve = release;
        });
        return () => {
          resolve(snapshot("/a"));
          opening = null;
        };
      },
      advance: async (milliseconds: number) => {
        const until = time + milliseconds;
        while (true) {
          const next = [...timers]
            .filter(([, timer]) => timer.at <= until)
            .sort((left, right) => left[1].at - right[1].at)[0];
          if (!next) break;
          const [id, timer] = next;
          time = timer.at;
          if (timer.interval) timer.at += timer.interval;
          else timers.delete(id);
          timer.callback();
          await settle();
        }
        time = until;
        await settle();
      },
    };
  }

  mock.module("../vendor/agentation/dist/index.mjs", () => ({
    Agentation: () => null,
    loadAnnotations: (route: string) =>
      JSON.parse(localStorage.getItem(`annotations:${route}`) ?? "[]"),
    saveAnnotations: (route: string, annotations: Annotation[]) =>
      localStorage.setItem(`annotations:${route}`, JSON.stringify(annotations)),
  }));
  mock.module("../lib/plugin-rpc.ts", () => ({ createRpcClient: () => ({ call: active.call }) }));

  async function mount() {
    const { startAnnotationToolbar } = await import("../lib/toolbar.ts");
    const dispose = startAnnotationToolbar("agentation", active.setView);
    return async () => {
      dispose();
      active.setView(null);
      await settle();
    };
  }

  afterEach(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
  });

  test("an Add queued on A persists to A after navigating to B", async () => {
    active = harness();
    const dispose = await mount();
    await active.advance(200);
    const annotation = {
      id: "annotation-a",
      comment: "Keep this feedback on A",
      timestamp: Date.now(),
      x: 10,
      y: 20,
      element: "button",
      elementPath: "body > button",
    } satisfies Annotation;
    expect(typeof active.view()?.onAnnotationAdd).toBe("function");
    active.view()!.onAnnotationAdd!(annotation);
    active.navigate("/b");
    await active.advance(250);

    expect(active.annotations.get("/a")).toEqual([annotation]);
    expect(active.annotations.has("/b")).toBe(false);
    const push = active.call.mock.calls.find(([method]) => method === "pushAnnotations");
    expect(push?.[1]).toMatchObject({
      sessionId: "session:/a",
      upserts: [{ annotation, bb: { route: "/a" } }],
    });
    expect(active.streams.size).toBe(1);
    expect(active.listeners.size).toBe(2);
    await dispose();
    expect(active.view()).toBeNull();
    expect(active.streams.size).toBe(0);
    expect(active.listeners.size).toBe(0);
    expect(active.timers.size).toBe(0);
  });

  test("reload during the first session request cleans up immediately", async () => {
    active = harness();
    const release = active.holdInitialSession();
    const dispose = await mount();
    await active.advance(0);
    expect(typeof active.view()?.onAnnotationAdd).toBe("function");
    await dispose();
    expect(active.view()).toBeNull();
    expect(active.listeners.size).toBe(0);
    expect(active.timers.size).toBe(0);
    const publicationCount = active.setView.mock.calls.length;
    release();
    await settle();
    expect(active.setView.mock.calls.length).toBe(publicationCount);
    expect(active.view()).toBeNull();
    expect(active.streams.size).toBe(0);
    expect(active.listeners.size).toBe(0);
    expect(active.timers.size).toBe(0);
  });

  test("effect replay leaves one active toolbar lifetime", async () => {
    active = harness();
    const release = active.holdInitialSession();
    const disposeFirst = await mount();
    await disposeFirst();
    const disposeSecond = await mount();
    release();
    await settle();
    expect(typeof active.view()?.onAnnotationAdd).toBe("function");
    expect(active.streams.size).toBe(1);
    expect(active.listeners.size).toBe(2);
    expect(active.timers.size).toBe(2);
    await disposeSecond();
    expect(active.streams.size).toBe(0);
    expect(active.listeners.size).toBe(0);
    expect(active.timers.size).toBe(0);
  });
}
