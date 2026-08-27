import { test } from "bun:test";
import assert from "node:assert/strict";

import {
  activeThreadView,
  createThreadAttention,
  parseAttentionMessage,
  type AttentionChannel,
  type AttentionEvent,
  type AttentionEventTarget,
  type AttentionSource,
  type NotificationInstance,
} from "./thread-attention.ts";

class FakeEvents implements AttentionEventTarget {
  readonly listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

class FakeChannel implements AttentionChannel {
  readonly listeners = new Set<(event: AttentionEvent) => void>();
  closed = false;

  constructor(readonly hub: FakeChannelHub) {}

  postMessage(message: unknown): void {
    this.hub.post(this, message);
  }

  addEventListener(_type: "message", listener: (event: AttentionEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: AttentionEvent) => void): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    this.hub.channels.delete(this);
  }

  receive(data: unknown): void {
    for (const listener of this.listeners) listener({ data });
  }
}

class FakeChannelHub {
  readonly channels = new Set<FakeChannel>();

  create(): FakeChannel {
    const channel = new FakeChannel(this);
    this.channels.add(channel);
    return channel;
  }

  post(sender: FakeChannel, message: unknown): void {
    for (const channel of this.channels) {
      if (channel !== sender) channel.receive(message);
    }
  }
}

function source(
  overrides: Partial<{
    pathname: string;
    visibilityState: DocumentVisibilityState;
    focused: boolean;
  }> = {},
): AttentionSource & {
  state: { pathname: string; visibilityState: DocumentVisibilityState; focused: boolean };
  windowEvents: FakeEvents;
  documentEvents: FakeEvents;
} {
  const state = {
    pathname: "/settings",
    visibilityState: "visible" as DocumentVisibilityState,
    focused: true,
    ...overrides,
  };
  return {
    state,
    windowEvents: new FakeEvents(),
    documentEvents: new FakeEvents(),
    pathname: () => state.pathname,
    visibilityState: () => state.visibilityState,
    hasFocus: () => state.focused,
  };
}

function notification() {
  const closeListeners = new Set<() => void>();
  const state = { closed: false };
  const instance: NotificationInstance = {
    addEventListener(_type: "close", listener: () => void) {
      closeListeners.add(listener);
    },
    close() {
      if (state.closed) return;
      state.closed = true;
      for (const listener of closeListeners) listener();
    },
  };
  return { instance, state };
}

test("ActiveThreadView requires the route-selected thread, visibility, and focus", () => {
  const current = source({ pathname: "/threads/thr_current" });
  assert.deepEqual(activeThreadView(current), { threadId: "thr_current" });

  current.state.focused = false;
  assert.equal(activeThreadView(current), null);
  current.state.focused = true;
  current.state.visibilityState = "hidden";
  assert.equal(activeThreadView(current), null);
  current.state.visibilityState = "visible";
  current.state.pathname = "/settings/notifications";
  assert.equal(activeThreadView(current), null);
});

test("AttentionMessage parses only correlated probes, probe hits, and viewed facts", () => {
  assert.deepEqual(
    parseAttentionMessage({ kind: "probe", probeId: "probe-1", threadId: "thr_1" }),
    { kind: "probe", probeId: "probe-1", threadId: "thr_1" },
  );
  assert.deepEqual(parseAttentionMessage({ kind: "probe-hit", probeId: "probe-1" }), {
    kind: "probe-hit",
    probeId: "probe-1",
  });
  assert.deepEqual(parseAttentionMessage({ kind: "viewed", threadId: "thr_1" }), {
    kind: "viewed",
    threadId: "thr_1",
  });
  assert.equal(parseAttentionMessage({ kind: "probe-hit", threadId: "thr_1" }), null);
  assert.equal(parseAttentionMessage({ kind: "viewed", threadId: "bad id" }), null);
});

test("an active target suppresses while the same background route shows then closes on focus", async () => {
  const controller = new AbortController();
  const current = source({ pathname: "/threads/thr_current" });
  const attention = createThreadAttention({
    signal: controller.signal,
    source: current,
    channel: null,
    probeTimeoutMs: 1,
  });
  let constructed = 0;

  assert.equal(
    await attention.present("thr_current", () => {
      constructed += 1;
      return notification().instance;
    }),
    "suppressed",
  );
  assert.equal(constructed, 0);

  current.state.focused = false;
  current.windowEvents.dispatch("blur");
  const shown = notification();
  assert.equal(await attention.present("thr_current", () => shown.instance), "shown");
  assert.equal(shown.state.closed, false);

  current.state.focused = true;
  current.windowEvents.dispatch("focus");
  assert.equal(shown.state.closed, true);
  controller.abort();
});

test("a different focused route shows, including an unfocused split whose thread is absent from the URL", async () => {
  const controller = new AbortController();
  const current = source({ pathname: "/threads/thr_focused" });
  const attention = createThreadAttention({
    signal: controller.signal,
    source: current,
    channel: null,
    probeTimeoutMs: 1,
  });
  const other = notification();

  assert.equal(await attention.present("thr_unfocused_split", () => other.instance), "shown");
  assert.equal(other.state.closed, false);
  controller.abort();
});

test("cross-window probes suppress and later viewed facts close creator-owned notifications", async () => {
  const controller = new AbortController();
  const hub = new FakeChannelHub();
  const creatorSource = source({ pathname: "/threads/thr_other", focused: true });
  const viewerSource = source({ pathname: "/threads/thr_target", focused: false });
  const creator = createThreadAttention({
    signal: controller.signal,
    source: creatorSource,
    channel: hub.create(),
    createProbeId: () => "creator-probe",
    probeTimeoutMs: 5,
  });
  createThreadAttention({
    signal: controller.signal,
    source: viewerSource,
    channel: hub.create(),
    createProbeId: () => "viewer-probe",
    probeTimeoutMs: 5,
  });

  const first = notification();
  assert.equal(await creator.present("thr_target", () => first.instance), "shown");
  viewerSource.state.focused = true;
  viewerSource.windowEvents.dispatch("focus");
  assert.equal(first.state.closed, true);

  let constructed = 0;
  assert.equal(
    await creator.present("thr_target", () => {
      constructed += 1;
      return notification().instance;
    }),
    "suppressed",
  );
  assert.equal(constructed, 0);
  controller.abort();
});

test("missing channels and unanswered probes fail open", async () => {
  const controller = new AbortController();
  const current = source({ pathname: "/threads/thr_other" });
  const withoutChannel = createThreadAttention({
    signal: controller.signal,
    source: current,
    channel: null,
    probeTimeoutMs: 1,
  });
  assert.equal(await withoutChannel.present("thr_target", () => notification().instance), "shown");

  const hub = new FakeChannelHub();
  const withoutReply = createThreadAttention({
    signal: controller.signal,
    source: current,
    channel: hub.create(),
    createProbeId: () => "no-reply",
    probeTimeoutMs: 1,
  });
  assert.equal(await withoutReply.present("thr_target", () => notification().instance), "shown");
  controller.abort();
});

test("a viewed fact during a pending probe suppresses before construction", async () => {
  const controller = new AbortController();
  const hub = new FakeChannelHub();
  const creatorChannel = hub.create();
  const peerChannel = hub.create();
  peerChannel.addEventListener("message", (event) => {
    const message = parseAttentionMessage(event.data);
    if (message?.kind === "probe") {
      hub.post(peerChannel, { kind: "viewed", threadId: message.threadId });
    }
  });
  const attention = createThreadAttention({
    signal: controller.signal,
    source: source({ pathname: "/settings" }),
    channel: creatorChannel,
    createProbeId: () => "pending-probe",
    probeTimeoutMs: 1,
  });
  let constructed = 0;

  assert.equal(
    await attention.present("thr_target", () => {
      constructed += 1;
      return notification().instance;
    }),
    "suppressed",
  );
  assert.equal(constructed, 0);
  controller.abort();
});

test("viewed closes every notification for one thread and leaves manual notifications open", async () => {
  const controller = new AbortController();
  const current = source({ pathname: "/settings" });
  const attention = createThreadAttention({
    signal: controller.signal,
    source: current,
    channel: null,
    probeTimeoutMs: 1,
  });
  const first = notification();
  const second = notification();
  const manual = notification();

  assert.equal(await attention.present("thr_target", () => first.instance), "shown");
  assert.equal(await attention.present("thr_target", () => second.instance), "shown");
  assert.equal(await attention.present(null, () => manual.instance), "shown");

  current.state.pathname = "/threads/thr_target";
  current.windowEvents.dispatch("pageshow");
  current.windowEvents.dispatch("pageshow");
  assert.equal(first.state.closed, true);
  assert.equal(second.state.closed, true);
  assert.equal(manual.state.closed, false);
  controller.abort();
});
