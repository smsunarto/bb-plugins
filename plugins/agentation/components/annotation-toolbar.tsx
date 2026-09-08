import { useEffect, useState } from "react";

import { startAnnotationToolbar, type ToolbarView } from "@/lib/toolbar.ts";
import { Agentation } from "../vendor/agentation/dist/index.mjs";

export function AnnotationToolbarOverlay() {
  const [view, setView] = useState<ToolbarView>(null);

  useEffect(() => startAnnotationToolbar("agentation", setView), []);

  return view === null ? null : <Agentation key={view.key} {...view.props} />;
}
