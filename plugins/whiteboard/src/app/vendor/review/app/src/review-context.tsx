// Vendored from dev.fast review/app/src/review-context.tsx @4ecc570 (MIT).
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

import { useReviewSession } from "./host/review-session.tsx";
import { captureUiEvent } from "../../../../stubs/telemetry.ts";

export interface SoftwareMapFocusRequest {
  requestId: number;
  elementPath: string;
}

export interface ReviewActionsValue {
  softwareMapEnabled: boolean;
  dismissReview: () => Promise<void>;
  openSoftwareMapElement: (elementPath: string) => void;
  openTraceSession?: (input: {
    sessionId: string;
    trace?: string;
    eventIndex?: number;
  }) => void;
}

export interface ReviewStateValue {
  historicalRevision: string | null;
  resolvedBaseRef: string | null;
  resolvedHeadRef: string | null;
  softwareMapFocusRequest: SoftwareMapFocusRequest | null;
}

export type ReviewContextValue = ReviewActionsValue & ReviewStateValue;

const ReviewActionsContext = createContext<ReviewActionsValue | null>(null);

const ReviewStateContext = createContext<ReviewStateValue | null>(null);

export function ReviewProvider({
  documentRoute,
  softwareMapEnabled = false,
  openTraceSession,
  children,
}: {
  documentRoute?: string;
  softwareMapEnabled?: boolean;
  openTraceSession?: (input: {
    sessionId: string;
    trace?: string;
    eventIndex?: number;
  }) => void;
  children: ReactNode;
}) {
  const session = useReviewSession();
  const reviewFetch = session.fetch;
  const review = session.review!;

  const [softwareMapFocusRequest, setSoftwareMapFocusRequest] =
    useState<SoftwareMapFocusRequest | null>(null);

  const openSoftwareMapElement = useCallback(
    (elementPath: string) => {
      if (!softwareMapEnabled) return;
      setSoftwareMapFocusRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        elementPath,
      }));
    },
    [softwareMapEnabled],
  );

  const dismissReview = useCallback(async () => {
    await review.dismiss();
    captureUiEvent(session, "review_dismissed", { via: "review_topbar" });
  }, [review, session]);

  const actions = useMemo<ReviewActionsValue>(
    () => ({
      softwareMapEnabled,
      dismissReview,
      openSoftwareMapElement,
      openTraceSession,
    }),
    [
      dismissReview,
      openSoftwareMapElement,
      openTraceSession,
      softwareMapEnabled,
    ],
  );

  const state = useMemo<ReviewStateValue>(
    () => ({
      historicalRevision: review.historicalRevision,
      resolvedBaseRef: review.pins?.base ?? null,
      resolvedHeadRef: review.pins?.head ?? null,
      softwareMapFocusRequest,
    }),
    [review, softwareMapFocusRequest],
  );

  return (
    <ReviewActionsContext.Provider value={actions}>
      <ReviewStateContext.Provider value={state}>
        {children}
      </ReviewStateContext.Provider>
    </ReviewActionsContext.Provider>
  );
}

export function useReviewActions(): ReviewActionsValue {
  const value = useContext(ReviewActionsContext);

  if (!value)
    throw new Error("Review components must render inside ReviewProvider");

  return value;
}

export function useReviewState(): ReviewStateValue {
  const value = useContext(ReviewStateContext);

  if (!value)
    throw new Error("Review components must render inside ReviewProvider");

  return value;
}

/** Merged view for consumers that need both halves. Re-renders on state changes. */
export function useReview(): ReviewContextValue {
  const actions = useReviewActions();
  const state = useReviewState();

  return useMemo(() => ({ ...actions, ...state }), [actions, state]);
}
