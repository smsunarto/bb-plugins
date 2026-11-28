import { afterEach, expect, test } from "bun:test";
import { installDom } from "@bb-plugins/testing";
import type { StoredAnnotation } from "../lib/afs.ts";

installDom();
const jsdomWindow = window as unknown as { Event: typeof Event; CustomEvent: typeof CustomEvent };
Object.assign(globalThis, { Event: jsdomWindow.Event, CustomEvent: jsdomWindow.CustomEvent });
window.matchMedia ??= (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

const { renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, cleanup, fireEvent, waitFor } = await import("@testing-library/react");
const { AnnotationPanel } = await import("../components/annotation-panel.tsx");

afterEach(cleanup);

function makeAnnotation(
  id: string,
  status: StoredAnnotation["status"],
  comment: string,
): StoredAnnotation {
  return {
    id,
    comment,
    element: "button",
    elementPath: "main > button",
    timestamp: 1,
    x: 10,
    y: 20,
    sessionId: "ses_1",
    status,
    kind: "feedback",
    thread: [],
    bb: {
      route: "/settings",
      routeLabel: "Settings",
      threadId: null,
      projectId: null,
      pluginId: null,
      surface: null,
    },
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    resolution: null,
    seq: 1,
  } as StoredAnnotation;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("switching filters ignores slower out-of-order listAnnotations responses", async () => {
  const openResponse = deferred<{
    annotations: StoredAnnotation[];
    routings: Record<string, never>;
  }>();
  const resolvedResponse = deferred<{
    annotations: StoredAnnotation[];
    routings: Record<string, never>;
  }>();

  const slot = renderSlot(
    { component: AnnotationPanel },
    {},
    {
      pluginId: "agentation",
      rpc: {
        listAnnotations: (input) => {
          const statuses = (input as { statuses: string[] | null }).statuses;
          if (statuses?.includes("resolved")) return resolvedResponse.promise;
          return openResponse.promise;
        },
        listSessions: () => ({ sessions: [] }),
      },
    },
  );

  // Switch from default "Open" to "Resolved" before the "Open" request resolves.
  fireEvent.click(slot.getByRole("radio", { name: "Resolved" }));

  await act(async () => {
    resolvedResponse.resolve({
      annotations: [makeAnnotation("ann_resolved", "resolved", "Resolved item")],
      routings: {},
    });
  });

  await waitFor(() => expect(slot.queryByText("Resolved item")).not.toBeNull());

  // Now the slower "Open" response arrives late; it must not overwrite the "Resolved" list.
  await act(async () => {
    openResponse.resolve({
      annotations: [makeAnnotation("ann_open", "pending", "Stale open item")],
      routings: {},
    });
    await Promise.resolve();
  });

  expect(slot.queryByText("Resolved item")).not.toBeNull();
  expect(slot.queryByText("Stale open item")).toBeNull();
});

test("a late rejection from an earlier filter does not overwrite a newer filter's data", async () => {
  const openResponse = deferred<{
    annotations: StoredAnnotation[];
    routings: Record<string, never>;
  }>();
  const resolvedResponse = deferred<{
    annotations: StoredAnnotation[];
    routings: Record<string, never>;
  }>();

  const slot = renderSlot(
    { component: AnnotationPanel },
    {},
    {
      pluginId: "agentation",
      rpc: {
        listAnnotations: (input) => {
          const statuses = (input as { statuses: string[] | null }).statuses;
          if (statuses?.includes("resolved")) return resolvedResponse.promise;
          return openResponse.promise;
        },
        listSessions: () => ({ sessions: [] }),
      },
    },
  );

  fireEvent.click(slot.getByRole("radio", { name: "Resolved" }));

  await act(async () => {
    resolvedResponse.resolve({
      annotations: [makeAnnotation("ann_resolved", "resolved", "Resolved item")],
      routings: {},
    });
  });

  await waitFor(() => expect(slot.queryByText("Resolved item")).not.toBeNull());

  await act(async () => {
    openResponse.reject(new Error("stale network failure"));
    await Promise.resolve();
  });

  expect(slot.queryByText("Resolved item")).not.toBeNull();
  expect(slot.queryByText("stale network failure")).toBeNull();
});
