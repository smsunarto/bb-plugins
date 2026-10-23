import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";

export function nav(app: CapturedPluginApp, subPath = "", tab?: string) {
  const panel = app.navPanels[0];
  const target = tab ? panel?.fixedTabs?.find((item) => item.id === tab) : panel;
  if (!target) throw new Error(`Missing navigation registration: ${tab ?? "main"}`);
  const Component = target.component;
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
