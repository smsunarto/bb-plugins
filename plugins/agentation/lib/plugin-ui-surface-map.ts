// Public bb plugin UI registrations and the source-level hints an agent needs
// to turn a captured surface name into a useful code search.

/**
 * Translate bb's internal component-boundary names to the public SDK API.
 * Covers every boundary bb 0.47 (Plugin SDK 0.6.75) mounts around plugin DOM;
 * boundaries that render nothing of their own (`composerCommand`,
 * `navPanelBadge`, `threadContextSegment/visibility`) cannot contain a
 * selected element and are left out.
 */
export const PUBLIC_SURFACE_BY_SLOT_KIND = {
  appOverlay: "experimental_appOverlay",
  browserToolbarAction: "experimental_browserToolbarAction",
  codeFenceRenderer: "experimental_codeFenceRenderer",
  composer: "experimental_composer",
  composerAction: "composer.actions",
  composerBanner: "composer.banners",
  composerPlusMenuItem: "composer.plusMenu",
  composerPopup: "composer.experimental_popups",
  composerSendMenuItem: "composer.sendMenu",
  diffRenderer: "experimental_diffRenderer",
  environmentProviderInputs: "experimental_environmentProviderInputs",
  experimental_sidebarFooter: "experimental_sidebarFooter",
  fileOpener: "fileOpener",
  homepageSection: "homepageSection",
  machineProviderInputs: "experimental_machineProviderInputs",
  messageDirective: "messageDirective",
  navPanel: "navPanel",
  navPanelSidebar: "navPanel.experimental_sidebar",
  newThreadPanelAction: "experimental_newThreadPanelAction.component",
  pendingInteraction: "pendingInteraction",
  settingsSection: "settingsSection",
  sidebarHeader: "experimental_sidebarNavigation.headerComponent",
  sidebarNavigation: "experimental_sidebarNavigation",
  sourceCodeRenderer: "experimental_sourceCodeRenderer",
  tab: "experimental_tab",
  "threadContextSegment/action": "experimental_threadContextSegment.action",
  "threadContextSegment/details": "experimental_threadContextSegment.details",
  "threadContextSegment/summary": "experimental_threadContextSegment.summary",
  threadHeaderAction: "experimental_threadHeaderAction",
  threadInfoRow: "experimental_threadInfoRow",
  threadInfoSection: "experimental_threadInfoSection",
  threadList: "experimental_threadList",
  timelineRenderer: "experimental_timelineRenderer",
} as const satisfies Readonly<Record<string, string>>;

/**
 * Boundaries that wrap host DOM around a hook rather than plugin DOM: bb mounts
 * a nav panel's `experimental_usePageTitle` around the whole page, header
 * included. The attribution walk looks through them to the element's real
 * owner.
 */
export const WRAPPER_SLOT_KINDS: ReadonlySet<string> = new Set(["navPanelPageTitle"]);

export interface PluginUiSurfacePromptContext {
  registration: string;
  role: string;
}

const PROMPT_CONTEXT_BY_SURFACE = {
  experimental_appOverlay: {
    registration: "app.slots.experimental_appOverlay",
    role: "a plugin component rendered over the whole bb window",
  },
  experimental_browserToolbarAction: {
    registration: "app.slots.experimental_browserToolbarAction",
    role: "a plugin component rendered beside a Browser tab's address bar",
  },
  experimental_codeFenceRenderer: {
    registration: "app.slots.experimental_codeFenceRenderer",
    role: "a plugin component rendering a fenced code block of a registered language in a message",
  },
  experimental_composer: {
    registration: "app.slots.experimental_composer",
    role: "the plugin component replacing the input box of bb's composer",
  },
  "composer.actions": {
    registration: "app.composer.customize({ actions })",
    role: "a plugin component rendered in the composer action row",
  },
  "composer.banners": {
    registration: "app.composer.customize({ banners })",
    role: "a plugin component rendered above the composer",
  },
  "composer.experimental_popups": {
    registration: "app.composer.customize({ experimental_popups })",
    role: "a plugin popup opened from the composer, placed like the mention menu",
  },
  "composer.plusMenu": {
    registration: "app.composer.customize({ plusMenu })",
    role: "a host-rendered plugin item in the composer's plus menu",
  },
  "composer.sendMenu": {
    registration: "app.composer.customize({ sendMenu })",
    role: "a host-rendered plugin item in the menu beside the composer's send button",
  },
  "composer.richText": {
    registration: "app.composer.customize({ richText })",
    role: "plugin-owned paint or behavior applied to composer text",
  },
  experimental_diffRenderer: {
    registration: "app.slots.experimental_diffRenderer",
    role: "the plugin component replacing bb's diff renderer",
  },
  experimental_environmentProviderInputs: {
    registration: "app.slots.experimental_environmentProviderInputs",
    role: "a plugin component collecting environment provider inputs for a new thread",
  },
  experimental_machineProviderInputs: {
    registration: "app.slots.experimental_machineProviderInputs",
    role: "a plugin component collecting machine provider inputs",
  },
  experimental_sidebarFooter: {
    registration: 'app.experimental_sidebarFooter.register({ kind: "disclosure" })',
    role: "a plugin disclosure opened from the sidebar footer",
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
  "navPanel.experimental_sidebar": {
    registration: "app.slots.navPanel({ experimental_sidebar })",
    role: "the plugin component shown in the sidebar instead of the thread list while its panel route is active",
  },
  "navPanel.headerContent": {
    registration: "app.slots.navPanel({ headerContent })",
    role: "the plugin component rendered in its panel header",
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
  settingsSection: {
    registration: "app.slots.settingsSection",
    role: "a plugin component rendered in its settings page",
  },
  experimental_sidebarNavigation: {
    registration: "app.slots.experimental_sidebarNavigation",
    role: "the plugin component drawing bb's sidebar navigation rows (New thread, Search, plugin panels)",
  },
  "experimental_sidebarNavigation.headerComponent": {
    registration: "app.slots.experimental_sidebarNavigation({ headerComponent })",
    role: "the plugin component drawing the sidebar header controls beside the sidebar toggle",
  },
  experimental_sourceCodeRenderer: {
    registration: "app.slots.experimental_sourceCodeRenderer",
    role: "the plugin component replacing bb's source code renderer",
  },
  sidebarFooterAction: {
    registration: "app.slots.sidebarFooterAction",
    role: "a host-rendered plugin action in the sidebar footer",
  },
  experimental_tab: {
    registration: "app.slots.experimental_tab",
    role: "a plugin tab in a thread's or a nav panel's side panel (fixed or opened by an action)",
  },
  "experimental_tab.run": {
    registration: 'app.slots.experimental_tab({ availability: "action", run })',
    role: "the host-rendered launcher for an action tab and its optional run handler",
  },
  experimental_threadAction: {
    registration: "app.slots.experimental_threadAction",
    role: "a host-rendered thread action in a thread menu or a sidebar row button, built by its item()",
  },
  "experimental_threadContextSegment.summary": {
    registration: "app.slots.experimental_threadContextSegment({ summary })",
    role: "the plugin component summarizing thread context beside the composer",
  },
  "experimental_threadContextSegment.action": {
    registration: "app.slots.experimental_threadContextSegment({ action })",
    role: "the plugin action control of a thread context segment beside the composer",
  },
  "experimental_threadContextSegment.details": {
    registration: "app.slots.experimental_threadContextSegment({ details })",
    role: "the plugin component showing a thread context segment's details",
  },
  experimental_threadHeaderAction: {
    registration: "app.slots.experimental_threadHeaderAction",
    role: "a plugin component rendered in the active thread header",
  },
  experimental_threadInfoRow: {
    registration: "app.slots.experimental_threadInfoRow",
    role: "a plugin row in the thread Info tab's details block",
  },
  experimental_threadInfoSection: {
    registration: "app.slots.experimental_threadInfoSection",
    role: "a plugin section in the thread Info tab",
  },
  experimental_threadList: {
    registration: "app.slots.experimental_threadList",
    role: "the plugin component replacing bb's sidebar thread list",
  },
  experimental_timelineRenderer: {
    registration: "app.slots.experimental_timelineRenderer",
    role: "a plugin component rendering a thread timeline row",
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
