import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";

export function nav(app: CapturedPluginApp, subPath = "", tab?: string) {
  const panel = app.navPanels[0];
  if (tab) {
    const target = app.tabs.find(
      (
        item,
      ): item is Extract<CapturedPluginApp["tabs"][number], { context: { kind: "nav-panel" } }> =>
        item.id === tab && item.context.kind === "nav-panel" && item.context.panelId === panel?.id,
    );
    if (!target || target.context.kind !== "nav-panel")
      throw new Error(`Missing navigation tab registration: ${tab}`);
    if (target.availability === "action") {
      const Component = target.component;
      return <Component subPath={subPath} params={target.params ?? null} />;
    }
    const Component = target.component;
    return <Component subPath={subPath} />;
  }
  if (!panel) throw new Error("Missing navigation registration: main");
  const Component = panel.component;
  return <Component subPath={subPath} />;
}
export function settings(app: CapturedPluginApp) {
  const Component = app.settingsSections[0]?.component;
  if (!Component) throw new Error("Missing settings registration");
  return <Component />;
}
export function directive(app: CapturedPluginApp, id: string, attributes: Record<string, string>) {
  const Component = app.messageDirectives.find((item) => item.id === id)?.component;
  if (!Component) throw new Error(`Missing directive: ${id}`);
  return (
    <Component
      attributes={attributes}
      source={`::${id}`}
      message={{ id: "msg_story", threadId: "thr_story", turnId: null, projectId: "proj_story" }}
      openWorkspaceFile={null}
    />
  );
}
export function banner(app: CapturedPluginApp, id: string) {
  const Component = app.composerCustomizations
    .flatMap((item) => item.banners ?? [])
    .find((item) => item.id === id)?.component;
  if (!Component) throw new Error(`Missing composer banner: ${id}`);
  return <Component />;
}

/** CSS scopes required by each plugin's own presentation components. */
export function previewSurfaceClass(title: string): string | undefined {
  if (/^(Components|Screens)\/Game Studio\//.test(title)) return "gs-app";
  if (/^(Components|Screens)\/Cloudflare\//.test(title)) return "cf-panel";
  return undefined;
}
