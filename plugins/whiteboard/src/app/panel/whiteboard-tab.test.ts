import type { ExperimentalPanelTab } from "@get-bb/plugin-sdk/app";
import { describe, expect, it, vi } from "vitest";
import { WHITEBOARD_TAB, focusWhiteboard } from "./whiteboard-tab.ts";

const whiteboardTab = (key: string, sessionId: string): ExperimentalPanelTab => ({
  key,
  title: sessionId,
  status: null,
  closable: true,
  detail: { kind: "plugin", pluginId: "whiteboard", tab: WHITEBOARD_TAB, params: { sessionId } },
});

function panelWith(tabs: ExperimentalPanelTab[]) {
  return {
    getTabs: () => ({ open: false, selectedKey: null, tabs }),
    selectTab: vi.fn(() => true),
    openTab: vi.fn(() => true),
  };
}

describe("focusWhiteboard", () => {
  it("selects the thread's newest Whiteboard tab instead of opening another", () => {
    const panel = panelWith([
      whiteboardTab("wb-1", "s1"),
      { key: "info", title: "Info", status: null, closable: false, detail: { kind: "info" } },
      whiteboardTab("wb-2", "s2"),
    ]);
    expect(focusWhiteboard(panel)).toBe(true);
    expect(panel.selectTab).toHaveBeenCalledWith("wb-2");
    expect(panel.openTab).not.toHaveBeenCalled();
  });

  it("opens Home in the tab when the thread has no Whiteboard tab", () => {
    const panel = panelWith([
      { key: "info", title: "Info", status: null, closable: false, detail: { kind: "info" } },
    ]);
    expect(focusWhiteboard(panel)).toBe(true);
    expect(panel.openTab).toHaveBeenCalledWith({ tab: WHITEBOARD_TAB });
    expect(panel.selectTab).not.toHaveBeenCalled();
  });
});
