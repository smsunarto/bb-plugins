import type {
  ReviewCanvasBridge,
  ReviewCanvasDiagnostic,
  ReviewRuntimeConfig,
} from "../../../shared/review-protocol/index.ts";
import { type ReactNode, createContext, useContext } from "react";

import type { WhiteboardRpcClient } from "../../rpc.ts";
import type { NormalizedSoftwareModel } from "../software-map/model.ts";
import type { PinnedSoftwareMapData } from "../software-map/SoftwareMap.tsx";
import { reviewStorageKey, reviewWasmUrl } from "./review-client.ts";
import { type ReviewSurface, createReviewSurface } from "./review-host.tsx";
import type { ReviewSessionData } from "./review-session-data.ts";

export interface ReviewSession {
  review?: ReviewSessionData;
  bridge: ReviewCanvasBridge;
  config: ReviewRuntimeConfig;
  surface: ReviewSurface;
  /** The panel's client: every call carries the panel's thread. */
  rpc: WhiteboardRpcClient;
  /** The canonical id of the session shown. */
  sessionId: string;
  /** The version on screen; undefined before the first document loads. */
  version(): number | undefined;
  softwareMapData?(model: NormalizedSoftwareModel): PinnedSoftwareMapData | undefined;
  wasmUrl(): string;
  storageKey(namespace: string, ...parts: Array<string | number | undefined>): string;
  theme(): ReviewRuntimeConfig["theme"];
  signalReady(): void;
  reportDiagnostic(diagnostic: ReviewCanvasDiagnostic): void;
}

export function createReviewSession(
  bridge: ReviewCanvasBridge,
  options: Pick<ReviewSession, "rpc" | "sessionId" | "version">,
): ReviewSession {
  const config = bridge.config;

  return {
    bridge,
    config,
    surface: createReviewSurface(bridge),
    rpc: options.rpc,
    sessionId: options.sessionId,
    version: options.version,
    wasmUrl: () => reviewWasmUrl(config),
    storageKey: (namespace, ...parts) => reviewStorageKey(config, namespace, ...parts),
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
  return <ReviewSessionContext.Provider value={session}>{children}</ReviewSessionContext.Provider>;
}

export function useOptionalReviewSession(): ReviewSession | null {
  return useContext(ReviewSessionContext);
}

export function useReviewSession(): ReviewSession {
  const session = useOptionalReviewSession();

  if (!session) {
    throw new Error("useReviewSession must be used within ReviewSessionProvider");
  }

  return session;
}
