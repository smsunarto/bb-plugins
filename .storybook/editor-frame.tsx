import { Component, lazy, Suspense, useLayoutEffect, useState, type ReactNode } from "react";
import { buildArgsParam } from "storybook/internal/router";
import { installNativeNetworkFixture } from "./native-network";
import { persistPreviewState } from "./preview-state";
import type { EditorContext } from "./editor-context";

let nativeModule: ReturnType<typeof importNativeFrame> | undefined;
function importNativeFrame() {
  installNativeNetworkFixture();
  document.documentElement.dataset.bbNativePreview = "loaded";
  return import("virtual:bb-native-frame");
}
export function preloadNativeFrame() {
  return (nativeModule ??= importNativeFrame());
}
const NativeEditorFrame = lazy(preloadNativeFrame);

export type PreviewLocation = {
  storyId: string;
  viewMode: string;
  globals: Record<string, unknown>;
  args: Record<string, unknown>;
  initialArgs: Record<string, unknown>;
};

export function previewURL(
  location: PreviewLocation,
  isolated = false,
  currentURL = window.location.href,
): string {
  const target = new URL(currentURL);
  if (location.viewMode !== "docs") target.searchParams.set("id", location.storyId);
  target.searchParams.set("viewMode", location.viewMode);
  target.searchParams.set(
    "globals",
    buildArgsParam({}, isolated ? { ...location.globals, context: "isolated" } : location.globals),
  );
  if (location.viewMode !== "docs")
    target.searchParams.set("args", buildArgsParam(location.initialArgs, location.args));
  return target.href;
}

export function IsolatedDocument({
  children,
  location,
}: {
  children: ReactNode;
  location: PreviewLocation;
}) {
  const reload = document.documentElement.dataset.bbNativePreview === "loaded";
  const target = previewURL(location);
  useLayoutEffect(() => {
    if (reload) {
      persistPreviewState(location, target);
      window.location.replace(target);
    }
  }, [reload, target, location]);
  return reload ? <output>Opening isolated preview…</output> : children;
}

class StoryBoundary extends Component<
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

class NativeBoundary extends Component<
  { children: ReactNode; isolatedURL: string; location: PreviewLocation },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(cause: unknown) {
    return { error: cause instanceof Error ? cause : new Error(String(cause)) };
  }
  override render() {
    return this.state.error ? (
      <section>
        <p>Native BB preview failed: {this.state.error.message}</p>
        <a
          href={this.props.isolatedURL}
          onClick={() => persistPreviewState(this.props.location, this.props.isolatedURL)}
        >
          Open isolated component
        </a>
      </section>
    ) : (
      this.props.children
    );
  }
}

export function EditorFrame({
  context,
  width,
  layout,
  children,
  location,
}: {
  context: EditorContext;
  width: string;
  layout?: string;
  children: ReactNode;
  location: PreviewLocation;
}) {
  const [storyError, setStoryError] = useState<Error | null>(null);
  if (storyError) throw storyError;
  if (!__BB_NATIVE_AVAILABLE__ || __BB_NATIVE_ERROR__)
    return (
      <>
        <output>
          Native BB preview unavailable:{" "}
          {__BB_NATIVE_ERROR__ || "Set BB_STORYBOOK_SOURCE to a local BB source checkout."}
        </output>
        {children}
      </>
    );
  return (
    <NativeBoundary isolatedURL={previewURL(location, true)} location={location}>
      <Suspense fallback={<output>Loading native BB editor…</output>}>
        <NativeEditorFrame context={context} width={width} layout={layout}>
          <StoryBoundary onError={setStoryError}>{children}</StoryBoundary>
        </NativeEditorFrame>
      </Suspense>
    </NativeBoundary>
  );
}
