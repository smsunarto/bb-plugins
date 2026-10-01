// Vendored from dev.fast review/app/src/host/review-session.tsx @4ecc570 (MIT).
import type {
  ReviewCanvasBridge,
  ReviewCanvasDiagnostic,
  ReviewRuntimeConfig,
} from "../../../../../../shared/vendor/review-protocol/src/index.ts";
import { type ReactNode, createContext, useContext } from "react";

import type { NormalizedSoftwareModel } from "../software-map/model.ts";
import type { PinnedSoftwareMapData } from "../software-map/SoftwareMap.tsx";
import { createReviewAppSessionId } from "../../../../../stubs/telemetry.ts";
import {
  type ReviewRequestOptions,
  jsonReviewApiUrl,
  reviewStorageKey,
  reviewWasmUrl,
} from "./review-client.ts";
import { type ReviewSurface, createReviewSurface } from "./review-host.tsx";
import type { ReviewSessionData } from "./review-session-data.ts";

export interface ReviewSession {
  review?: ReviewSessionData;
  appSessionId: string;
  bridge: ReviewCanvasBridge;
  config: ReviewRuntimeConfig;
  surface: ReviewSurface;
  softwareMapData?(
    model: NormalizedSoftwareModel,
  ): PinnedSoftwareMapData | undefined;
  apiUrl(endpoint: `/${string}`, options?: ReviewRequestOptions): string;
  fetch: (
    endpoint: `/${string}`,
    init?: RequestInit,
    options?: ReviewRequestOptions,
  ) => Promise<Response>;
  fetchUrl(url: string | URL, init?: RequestInit): Promise<Response>;
  beaconUrl(endpoint: `/${string}`): string;
  wasmUrl(): string;
  storageKey(
    namespace: string,
    ...parts: Array<string | number | undefined>
  ): string;
  theme(): ReviewRuntimeConfig["theme"];
  signalReady(): void;
  reportDiagnostic(diagnostic: ReviewCanvasDiagnostic): void;
}

export function createReviewSession(
  bridge: ReviewCanvasBridge,
  options: { jsonReview: { id: string; version(): number | undefined } },
): ReviewSession {
  const config = bridge.config;
  const appSessionId = bridge.appSessionId ?? createReviewAppSessionId();

  const request = (url: string | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);

    if (config.token) headers.set("x-review-token", config.token);

    return bridge.request(String(url), { ...init, headers });
  };

  const apiUrl = (
    endpoint: `/${string}`,
    requestOptions?: ReviewRequestOptions,
  ) =>
    jsonReviewApiUrl(config, options.jsonReview.id, endpoint, {
      version: options.jsonReview.version(),
      tokenInQuery: requestOptions?.tokenInQuery,
    });

  return {
    appSessionId,
    bridge,
    config,
    surface: createReviewSurface(bridge),
    apiUrl,
    fetch: (endpoint, init, options) =>
      request(apiUrl(endpoint, options), init),
    fetchUrl: request,
    beaconUrl: (endpoint) => apiUrl(endpoint, { tokenInQuery: true }),
    wasmUrl: () => reviewWasmUrl(config),
    storageKey: (namespace, ...parts) =>
      reviewStorageKey(config, namespace, ...parts),
    theme: () => bridge.currentTheme(),
    signalReady: () => bridge.ready(),
    reportDiagnostic: (diagnostic) => bridge.reportDiagnostic?.(diagnostic),
  };
}

const ReviewSessionContext = createContext<ReviewSession | null>(null);

export function ReviewSessionProvider({
  session,
  children,
}: {
  session: ReviewSession;
  children: ReactNode;
}) {
  return (
    <ReviewSessionContext.Provider value={session}>
      {children}
    </ReviewSessionContext.Provider>
  );
}

export function useOptionalReviewSession(): ReviewSession | null {
  return useContext(ReviewSessionContext);
}

export function useReviewSession(): ReviewSession {
  const session = useOptionalReviewSession();

  if (!session) {
    throw new Error(
      "useReviewSession must be used within ReviewSessionProvider",
    );
  }

  return session;
}
