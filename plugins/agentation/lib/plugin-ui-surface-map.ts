// Public bb plugin UI registrations and the source-level hints an agent needs
// to turn a captured surface name into a useful code search.

/** Translate bb's internal component-boundary names to the public SDK API. */
export const PUBLIC_SURFACE_BY_SLOT_KIND = {
  composerAction: "composer.actions",
  composerBanner: "composer.banners",
  composerPlusMenuItem: "composer.plusMenu",
  fileOpener: "fileOpener",
  homepageSection: "homepageSection",
  messageDirective: "messageDirective",
  navPanel: "navPanel",
  navPanelFixedTab: "navPanel.experimental_fixedTabs",
  navPanelHeaderContent: "navPanel.headerContent",
  navPanelSidebarAccessory: "navPanel.experimental_sidebarAccessory",
  newThreadPanelAction: "experimental_newThreadPanelAction.component",
  pendingInteraction: "pendingInteraction",
  providerIcon: "experimental_providerIcon",
  settingsSection: "settingsSection",
  threadHeaderAction: "experimental_threadHeaderAction",
  threadList: "experimental_threadList",
  threadPanelAction: "threadPanelAction.component",
} as const satisfies Readonly<Record<string, string>>;

export interface PluginUiSurfacePromptContext {
  registration: string;
  role: string;
}

const PROMPT_CONTEXT_BY_SURFACE = {
  "composer.actions": {
    registration: "app.composer.customize({ actions })",
    role: "a plugin component rendered in the composer action row",
  },
  "composer.banners": {
    registration: "app.composer.customize({ banners })",
    role: "a plugin component rendered above the composer",
  },
  "composer.plusMenu": {
    registration: "app.composer.customize({ plusMenu })",
    role: "a host-rendered plugin item in the composer's plus menu",
  },
  "composer.richText": {
    registration: "app.composer.customize({ richText })",
    role: "plugin-owned paint or behavior applied to composer text",
  },
  fileOpener: {
    registration: "app.slots.fileOpener",
    role: "a plugin component rendering an opened file panel",
  },
  homepageSection: {
    registration: "app.slots.homepageSection",
    role: "a plugin component rendered on bb's home page",
  },
  messageAction: {
    registration: "app.slots.messageAction",
    role: "a host-rendered action contributed to a message",
  },
  messageDirective: {
    registration: "app.slots.messageDirective",
    role: "a plugin component rendering an assistant message directive",
  },
  navPanel: {
    registration: "app.slots.navPanel",
    role: "the plugin-owned route panel",
  },
  "navPanel.experimental_fixedTabs": {
    registration: "app.slots.navPanel({ experimental_fixedTabs })",
    role: "a fixed tab declared by the plugin's navigation panel",
  },
  "navPanel.headerContent": {
    registration: "app.slots.navPanel({ headerContent })",
    role: "the plugin component rendered in its panel header",
  },
  "navPanel.experimental_sidebarAccessory": {
    registration: "app.slots.navPanel({ experimental_sidebarAccessory })",
    role: "an accessory declared beside the plugin's sidebar entry",
  },
  "experimental_newThreadPanelAction.component": {
    registration: "app.slots.experimental_newThreadPanelAction({ component })",
    role: "the plugin panel opened from the new-thread action launcher",
  },
  "experimental_newThreadPanelAction.run": {
    registration: "app.slots.experimental_newThreadPanelAction({ run })",
    role: "the host-rendered new-thread action and its run handler",
  },
  pendingInteraction: {
    registration: "app.slots.pendingInteraction",
    role: "a plugin component handling a pending thread interaction",
  },
  experimental_providerIcon: {
    registration: "app.slots.experimental_providerIcon",
    role: "a plugin component drawing an agent provider icon",
  },
  settingsSection: {
    registration: "app.slots.settingsSection",
    role: "a plugin component rendered in its settings page",
  },
  sidebarFooterAction: {
    registration: "app.slots.sidebarFooterAction",
    role: "a host-rendered plugin action in the sidebar footer",
  },
  experimental_threadHeaderAction: {
    registration: "app.slots.experimental_threadHeaderAction",
    role: "a plugin component rendered in the active thread header",
  },
  experimental_threadList: {
    registration: "app.slots.experimental_threadList",
    role: "the plugin component replacing bb's sidebar thread list",
  },
  "threadPanelAction.component": {
    registration: "app.slots.threadPanelAction({ component })",
    role: "the plugin panel opened from a thread action launcher",
  },
  "threadPanelAction.run": {
    registration: "app.slots.threadPanelAction({ run })",
    role: "the host-rendered thread action and its run handler",
  },
  inline: {
    registration: "app.contentScripts.register or custom plugin DOM",
    role: "trusted plugin content rendered outside a named component slot",
  },
  overlay: {
    registration: "app.contentScripts.register or a plugin portal",
    role: "trusted plugin content rendered in an overlay",
  },
} as const satisfies Readonly<Record<string, PluginUiSurfacePromptContext>>;

/** Source-oriented context for a captured public surface, including future ones. */
export function pluginUiSurfacePromptContext(surface: string): PluginUiSurfacePromptContext {
  return (
    PROMPT_CONTEXT_BY_SURFACE[surface as keyof typeof PROMPT_CONTEXT_BY_SURFACE] ?? {
      registration: surface,
      role: "a plugin UI contribution registered from the plugin frontend",
    }
  );
}
