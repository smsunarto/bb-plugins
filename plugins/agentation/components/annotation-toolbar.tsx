import { useEffect, useState, useSyncExternalStore } from "react";

import { startAnnotationToolbar, type ToolbarView } from "@/lib/toolbar.ts";
import { Agentation } from "../vendor/agentation/dist/index.mjs";
import {
  feedbackModeSnapshot,
  feedbackModeLauncher,
  setFeedbackModeActive,
  subscribeFeedbackMode,
} from "@/lib/feedback-mode.ts";

export function AnnotationToolbarOverlay() {
  const [view, setView] = useState<ToolbarView>(null);
  const active = useSyncExternalStore(subscribeFeedbackMode, feedbackModeSnapshot);

  useEffect(() => startAnnotationToolbar("agentation", setView), []);
  useEffect(() => {
    if (view === null) setFeedbackModeActive(false);
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
