import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { subscribeRouteChange } from "@/lib/route.ts";
import { hasLocalAnnotations, startAnnotationToolbar, type ToolbarView } from "@/lib/toolbar.ts";
import { Agentation } from "../vendor/agentation/dist/index.mjs";
import {
  activateFeedbackMode,
  feedbackModeSnapshot,
  feedbackModeLauncher,
  setFeedbackModeActive,
  subscribeFeedbackMode,
} from "@/lib/feedback-mode.ts";

function currentRouteHasAnnotations(): boolean {
  if (typeof window === "undefined") return false;
  return hasLocalAnnotations(window.location.pathname);
}

export function AnnotationToolbarOverlay() {
  const [view, setView] = useState<ToolbarView>(null);
  const active = useSyncExternalStore(subscribeFeedbackMode, feedbackModeSnapshot);
  const [engaged, setEngaged] = useState(() => active || currentRouteHasAnnotations());
  const shouldRun = engaged || active;

  // While idle (feedback mode off and no local annotations), avoid starting the
  // toolbar, opening sessions, or holding an EventSource. Still listen for the
  // keyboard shortcut, feedback-mode activation, and route changes to a page
  // that has local annotations.
  useEffect(() => {
    if (shouldRun) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.key === "f" || event.key === "F")
      ) {
        event.preventDefault();
        activateFeedbackMode();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    const stopFeedback = subscribeFeedbackMode(() => {
      if (feedbackModeSnapshot()) setEngaged(true);
    });
    const stopRoute = subscribeRouteChange(() => {
      if (currentRouteHasAnnotations()) setEngaged(true);
    });
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      stopFeedback();
      stopRoute();
    };
  }, [shouldRun]);

  useEffect(() => {
    if (!shouldRun) return;
    return startAnnotationToolbar("agentation", setView);
  }, [shouldRun]);

  const hadView = useRef(false);
  useEffect(() => {
    if (view !== null) {
      hadView.current = true;
    } else if (hadView.current) {
      hadView.current = false;
      setFeedbackModeActive(false);
    }
  }, [view]);

  return view === null ? null : (
    <Agentation
      key={view.key}
      {...view.props}
      active={active}
      onActiveChange={setFeedbackModeActive}
      getLauncherElement={feedbackModeLauncher}
      hideLauncher
    />
  );
}
