import { type PluginNavPanelProps, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { NAV_PANEL_PATH } from "../../shared/contracts/panel.ts";
import { Button } from "../components/ui/button.tsx";
import { routeSessionId } from "./home-panel.tsx";

export const ALL_WHITEBOARDS = "All Whiteboards";

/**
 * The navPanel's title-bar control. bb renders it at the right end of its
 * title bar, so a full-page session links back to Home without a row of its
 * own. Home itself shows nothing here.
 */
export function HomeHeader({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  if (!routeSessionId(subPath)) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => navigate.toPluginPanel(NAV_PANEL_PATH, { subPath: "" })}
    >
      {ALL_WHITEBOARDS}
    </Button>
  );
}
