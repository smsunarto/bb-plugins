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

import { monokaiCodeTheme } from "./monokai";

installTestPluginRuntime();
pluginQueryClient.setDefaultOptions({ queries: { retry: false } });

const DEFAULT_OPTIONS: RenderSlotOptions = {};

class FixtureBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function FixtureContent({
  children,
  onError,
}: {
  children: ReactNode;
  onError: (error: Error) => void;
}) {
  return (
    <FixtureBoundary onError={onError}>
      <PluginQueryBoundary>{children}</PluginQueryBoundary>
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
}: {
  children: ReactNode;
  storyId: string;
  options?: RenderSlotOptions;
}) {
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
      pluginQueryClient.clear();
      try {
        slot = renderSlot(
          { component: FixtureContent },
          { children: content.current, onError: setError },
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
      });
    };
  }, [storyId, options]);
  useEffect(() => {
    mountedSlot.current?.lifecycle.rerender(
      <FixtureContent onError={setError}>{children}</FixtureContent>,
    );
  }, [children]);
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
