import { Component, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
  type PluginAppSource,
  type RenderSlotOptions,
} from "@get-bb/plugin-sdk/testing/app";
import { PluginQueryBoundary, pluginQueryClient } from "@bb-kit/core/rpc/query";
import { QueryClient } from "@tanstack/react-query";

import { monokaiCodeTheme } from "./monokai";

installTestPluginRuntime();
pluginQueryClient.setDefaultOptions({ queries: { retry: false } });

const DEFAULT_OPTIONS: RenderSlotOptions = {};

class FixtureBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

function FixtureContent({
  children,
  onError,
  queryClient,
}: {
  children: ReactNode;
  onError: (error: Error) => void;
  queryClient: QueryClient;
}) {
  return (
    <FixtureBoundary onError={onError}>
      <PluginQueryBoundary client={queryClient}>{children}</PluginQueryBoundary>
    </FixtureBoundary>
  );
}

function cancellableRpc(
  rpc: RenderSlotOptions["rpc"],
  signal: AbortSignal,
): RenderSlotOptions["rpc"] {
  return Object.fromEntries(
    Object.entries(rpc ?? {}).map(([name, handler]) => [
      name,
      (input: unknown) =>
        new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("Story fixture disposed", "AbortError"));
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve()
            .then(() => handler(input))
            .then(resolve, reject)
            .finally(() => {
              signal.removeEventListener("abort", abort);
            });
        }),
    ]),
  );
}

/** Public SDK harness: no real BB server, filesystem, or account is contacted. */
export function HostFixture({
  children,
  storyId,
  options = DEFAULT_OPTIONS,
  sharedQueryClient = false,
}: {
  children: ReactNode;
  storyId: string;
  options?: RenderSlotOptions;
  sharedQueryClient?: boolean;
}) {
  const [queryClient] = useState(() =>
    sharedQueryClient
      ? pluginQueryClient
      : new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  const host = useRef<HTMLDivElement>(null);
  const content = useRef(children);
  useLayoutEffect(() => {
    content.current = children;
  }, [children]);
  const mountedSlot = useRef<ReturnType<typeof renderSlot> | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let slot: ReturnType<typeof renderSlot> | undefined;
    queueMicrotask(() => {
      if (!active || !host.current) return;
      if (sharedQueryClient) {
        queryClient.clear();
      }
      try {
        slot = renderSlot(
          { component: FixtureContent },
          { children: content.current, onError: setError, queryClient },
          {
            pluginId: "storybook",
            ...options,
            codeTheme: monokaiCodeTheme,
            rpc: cancellableRpc(options.rpc, controller.signal),
          },
        );
        slot.container.dataset.storyId = storyId;
        host.current.append(slot.container);
        mountedSlot.current = slot;
      } catch (cause) {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
    return () => {
      active = false;
      controller.abort();
      mountedSlot.current = null;
      const mounted = slot;
      queueMicrotask(() => {
        mounted?.lifecycle.unmount();
        mounted?.container.remove();
        queryClient.clear();
      });
    };
  }, [storyId, options, queryClient, sharedQueryClient]);
  useEffect(() => {
    let active = true;
    // renderSlot's rerender uses act(), which must run after React's commit.
    queueMicrotask(() => {
      if (!active) return;
      mountedSlot.current?.lifecycle.rerender(
        <FixtureContent onError={setError} queryClient={queryClient}>
          {children}
        </FixtureContent>,
      );
    });
    return () => {
      active = false;
    };
  }, [children, queryClient]);
  if (error) throw error;
  return <div ref={host} data-storybook-host="" />;
}

/** Render the component registered by a plugin without changing its exports. */
export function RegisteredSurface({
  source,
  select,
}: {
  source: PluginAppSource;
  select: (app: CapturedPluginApp) => ReactNode;
}) {
  const [app, setApp] = useState<CapturedPluginApp | null>(null);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void loadPluginApp(source).then(
      (value) => {
        if (active) setApp(value);
        return undefined;
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
        return undefined;
      },
    );
    return () => {
      active = false;
    };
  }, [source]);
  if (error) throw error;
  if (!app) return <output>Loading component…</output>;
  return select(app);
}

export function Gallery({ children }: { children: ReactNode }) {
  return <div className="sb-gallery">{children}</div>;
}
