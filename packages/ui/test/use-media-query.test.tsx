import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { act, cleanup, render } = await import("@testing-library/react");
const { useMediaQuery } = await import("../registry/hooks/use-media-query");

type ChangeListener = (event: MediaQueryListEvent) => void;

interface QueryRecord {
  matches: boolean;
  matchMediaCalls: number;
  addListenerCalls: number;
  removeListenerCalls: number;
  listeners: Set<ChangeListener>;
  instances: Set<{ matches: boolean }>;
}

function installFakeMatchMedia(initial: Record<string, boolean> = {}) {
  const records = new Map<string, QueryRecord>();

  const getRecord = (query: string): QueryRecord => {
    let record = records.get(query);
    if (!record) {
      record = {
        matches: initial[query] ?? false,
        matchMediaCalls: 0,
        addListenerCalls: 0,
        removeListenerCalls: 0,
        listeners: new Set(),
        instances: new Set(),
      };
      records.set(query, record);
    }
    return record;
  };

  const matchMedia = (query: string): MediaQueryList => {
    const record = getRecord(query);
    record.matchMediaCalls += 1;
    const mql = {
      media: query,
      matches: record.matches,
      onchange: null,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "change" && typeof listener === "function") {
          record.addListenerCalls += 1;
          record.listeners.add(listener as ChangeListener);
        }
      },
      removeEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === "change" && typeof listener === "function") {
          record.removeListenerCalls += 1;
          record.listeners.delete(listener as ChangeListener);
        }
      },
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return true;
      },
    } as unknown as MediaQueryList;
    record.instances.add(mql);
    return mql;
  };

  const original = window.matchMedia;
  window.matchMedia = matchMedia;

  return {
    record(query: string) {
      return getRecord(query);
    },
    setMatches(query: string, matches: boolean) {
      const record = getRecord(query);
      record.matches = matches;
      for (const instance of record.instances) {
        instance.matches = matches;
      }
      const event = { matches, media: query } as MediaQueryListEvent;
      for (const listener of record.listeners) {
        listener(event);
      }
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

function Probe({ query, tick = 0 }: { query: string; tick?: number }) {
  const matches = useMediaQuery(query);
  return (
    <output data-testid="probe" data-tick={tick}>
      {String(matches)}
    </output>
  );
}

describe("useMediaQuery", () => {
  let fake: ReturnType<typeof installFakeMatchMedia>;

  beforeEach(() => {
    fake = installFakeMatchMedia();
  });

  afterEach(() => {
    cleanup();
    fake.restore();
  });

  test("subscribes once per mounted query across re-renders", () => {
    const query = "(max-width: 767px)";
    const { getByTestId, rerender, unmount } = render(<Probe query={query} tick={0} />);

    expect(getByTestId("probe").textContent).toBe("false");
    const rec = fake.record(query);
    const matchMediaCallsAfterMount = rec.matchMediaCalls;
    expect(rec.addListenerCalls).toBe(1);
    expect(rec.removeListenerCalls).toBe(0);

    for (let tick = 1; tick <= 5; tick += 1) {
      rerender(<Probe query={query} tick={tick} />);
    }

    expect(rec.addListenerCalls).toBe(1);
    expect(rec.removeListenerCalls).toBe(0);
    expect(rec.matchMediaCalls).toBe(matchMediaCallsAfterMount);

    const second = render(<Probe query={query} tick={0} />);
    expect(rec.addListenerCalls).toBe(1);
    expect(rec.removeListenerCalls).toBe(0);
    expect(rec.matchMediaCalls).toBe(matchMediaCallsAfterMount);

    second.unmount();
    expect(rec.removeListenerCalls).toBe(0);

    unmount();
    expect(rec.removeListenerCalls).toBe(1);
  });

  test("re-renders when a change event fires without resubscribing", () => {
    const query = "(prefers-reduced-motion: reduce)";
    const { getByTestId } = render(<Probe query={query} />);
    const rec = fake.record(query);
    const matchMediaCallsAfterMount = rec.matchMediaCalls;

    expect(getByTestId("probe").textContent).toBe("false");

    act(() => {
      fake.setMatches(query, true);
    });

    expect(getByTestId("probe").textContent).toBe("true");
    expect(rec.addListenerCalls).toBe(1);
    expect(rec.removeListenerCalls).toBe(0);
    expect(rec.matchMediaCalls).toBe(matchMediaCallsAfterMount);

    act(() => {
      fake.setMatches(query, false);
    });

    expect(getByTestId("probe").textContent).toBe("false");
    expect(rec.addListenerCalls).toBe(1);
    expect(rec.removeListenerCalls).toBe(0);
  });

  test("resubscribes when the query changes and updates on the new query's events", () => {
    const first = "(max-width: 767px)";
    const second = "(pointer: coarse)";
    fake.setMatches(second, true);

    const { getByTestId, rerender, unmount } = render(<Probe query={first} tick={0} />);
    expect(getByTestId("probe").textContent).toBe("false");
    expect(fake.record(first).addListenerCalls).toBe(1);
    expect(fake.record(first).removeListenerCalls).toBe(0);

    rerender(<Probe query={second} tick={1} />);
    expect(getByTestId("probe").textContent).toBe("true");
    expect(fake.record(first).removeListenerCalls).toBe(1);
    expect(fake.record(second).addListenerCalls).toBe(1);
    expect(fake.record(second).removeListenerCalls).toBe(0);

    // Events on the old query no longer drive this component.
    act(() => {
      fake.setMatches(first, true);
    });
    expect(getByTestId("probe").textContent).toBe("true");

    // Events on the new query do re-render it.
    act(() => {
      fake.setMatches(second, false);
    });
    expect(getByTestId("probe").textContent).toBe("false");

    // Subsequent re-renders with the new query keep the subscription stable.
    const secondMatchMediaCalls = fake.record(second).matchMediaCalls;
    rerender(<Probe query={second} tick={2} />);
    rerender(<Probe query={second} tick={3} />);
    expect(fake.record(second).addListenerCalls).toBe(1);
    expect(fake.record(second).removeListenerCalls).toBe(0);
    expect(fake.record(second).matchMediaCalls).toBe(secondMatchMediaCalls);

    unmount();
    expect(fake.record(second).removeListenerCalls).toBe(1);
  });
});
