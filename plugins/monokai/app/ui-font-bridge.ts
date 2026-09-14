import { useSettings } from "@get-bb/plugin-sdk/app";
import { useEffect } from "react";

import { UI_FONT_STACKS, normalizeUiFont } from "../shared/ui-font.ts";

const UI_FONT_PROPERTY = "--bb-monokai-ui-font";

interface StyleTarget {
  getPropertyPriority(name: string): string;
  getPropertyValue(name: string): string;
  removeProperty(name: string): string;
  setProperty(name: string, value: string, priority?: string): void;
}

export function applyUiFontPreference(style: StyleTarget, value: unknown): () => void {
  const previousValue = style.getPropertyValue(UI_FONT_PROPERTY);
  const previousPriority = style.getPropertyPriority(UI_FONT_PROPERTY);
  style.setProperty(
    UI_FONT_PROPERTY,
    UI_FONT_STACKS[normalizeUiFont(typeof value === "string" ? value : "")],
  );

  return () => {
    if (previousValue.length === 0) {
      style.removeProperty(UI_FONT_PROPERTY);
    } else {
      style.setProperty(UI_FONT_PROPERTY, previousValue, previousPriority);
    }
  };
}

export function UiFontBridge(): null {
  const { values } = useSettings();
  const uiFont = values?.uiFont;

  useEffect(() => {
    if (uiFont === undefined) return;
    return applyUiFontPreference(document.documentElement.style, uiFont);
  }, [uiFont]);

  return null;
}
