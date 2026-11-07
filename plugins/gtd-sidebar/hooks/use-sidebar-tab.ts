import { useEffect, useState } from "react";

export type SidebarTab = "code" | "bots";

const STORAGE_KEY = "gtd-sidebar:v1:tab";

function readTab(): SidebarTab {
  try {
    return localStorage.getItem(STORAGE_KEY) === "bots" ? "bots" : "code";
  } catch {
    return "code";
  }
}

/**
 * The sidebar's open tab, remembered on this device across reloads. The
 * setter is plain state, so a render may call it to follow navigation.
 */
export function useSidebarTab(): [SidebarTab, (tab: SidebarTab) => void] {
  const [tab, setTab] = useState(readTab);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, tab);
    } catch {
      // No web storage: the choice lasts for this session.
    }
  }, [tab]);
  return [tab, setTab];
}
