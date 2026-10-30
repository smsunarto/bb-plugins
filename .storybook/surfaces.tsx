import type { JsonValue, PluginMachineProviderInputsChange } from "@get-bb/plugin-sdk/app";
import type { CapturedPluginApp } from "@get-bb/plugin-sdk/testing/app";
import { useCallback, useState } from "react";

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
export function composerAction(app: CapturedPluginApp, id: string) {
  const Component = app.composerCustomizations
    .flatMap((item) => item.actions ?? [])
    .find((item) => item.id === id)?.component;
  if (!Component) throw new Error(`Missing composer action: ${id}`);
  // The host mounts each action in a fixed-height row cell.
  return (
    <div className="flex h-9 max-h-9 items-center overflow-hidden">
      <Component />
    </div>
  );
}

export function machineProviderInputs(app: CapturedPluginApp, machineProviderId: string) {
  const Component = app.machineProviderInputs.find(
    (item) => item.machineProviderId === machineProviderId,
  )?.component;
  if (!Component) throw new Error(`Missing machine provider inputs: ${machineProviderId}`);
  return <MachineProviderInputsHost component={Component} />;
}

/** Holds the submitted value the way the machine picker does, so choices show. */
function MachineProviderInputsHost({
  component: Component,
}: {
  component: CapturedPluginApp["machineProviderInputs"][number]["component"];
}) {
  const [value, setValue] = useState<JsonValue | null>(null);
  const onChange = useCallback((next: PluginMachineProviderInputsChange) => {
    if (next.status === "ready") setValue(next.value);
  }, []);
  return <Component value={value} onChange={onChange} />;
}

/** CSS scopes required by each plugin's own presentation components. */
export function previewSurfaceClass(_title: string): string | undefined {
  return undefined;
}
