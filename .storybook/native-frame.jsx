import { useLayoutEffect, useMemo, useState } from "react";
import { MemoryRouter } from "@bb-native/deps/react-router-dom";
import { Provider as JotaiProvider, createStore } from "@bb-native/deps/jotai";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@bb-native/deps/@bb/shared-ui/tooltip";
import { Button } from "@bb-native/deps/@bb/shared-ui/button";
import { Icon } from "@bb-native/deps/@bb/shared-ui/icon";
import {
  PROJECT_LIST_ACTION_BUTTON_CLASS,
  SIDEBAR_RAIL_BUTTON_CLASS,
  SIDEBAR_FOOTER_ACTION_CLASS,
} from "@bb-native/deps/@bb/shared-ui/sidebar-row-classes";
import { RouteNavigationProvider } from "@bb-native/app/components/ui/app-route-anchor";
import {
  Sidebar,
  SidebarCollapsibleBody,
  SidebarContent,
  SidebarInset,
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useIsSidebarFramed,
} from "@bb-native/app/components/ui/sidebar";
import { SidebarTopReserveRow } from "@bb-native/app/components/sidebar/SidebarChrome";
import { SidebarHistoryNavigationControls } from "@bb-native/app/components/sidebar/SidebarHistoryNavigationControls";
import {
  NAV_RAIL_WIDTH_CLASS,
  NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH,
} from "@bb-native/app/components/sidebar/navRailWidth";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
} from "@bb-native/app/components/layout/AppPageHeader";
import { ThreadTitle } from "@bb-native/app/components/thread/ThreadTitleMentions";
import { BottomAnchoredScrollBody } from "@bb-native/app/components/ui/bottom-anchored-scroll-body";
import { PageShell } from "@bb-native/app/components/ui/page-shell";
import { SettingsSidebarContent } from "@bb-native/app/components/settings/SettingsSidebar";
import { SETTINGS_NAV_SECTIONS } from "@bb-native/app/components/settings/settings-sections";
import { PluginIcon } from "@bb-native/app/components/plugin/PluginIcon";
import { SecondaryPanelLayout } from "@bb-native/app/components/secondary-panel/SecondaryPanelLayout";
import { ThreadSecondaryPanel } from "@bb-native/app/components/secondary-panel/ThreadSecondaryPanel";
import { createPluginPanelFixedPanelTab } from "@bb-native/app/lib/fixed-panel-tabs-state";
import { ConversationMessageContent } from "@bb-native/app/components/thread/timeline/ConversationMessageContent";
import { useStoryPromptDraft } from "@bb-native/app/components/thread/timeline/StoryDraftPromptBox";
import { FollowUpPromptBox } from "@bb-native/app/components/promptbox/FollowUpPromptBox";
import {
  getFollowUpPromptPlaceholder,
  getCompactFollowUpPromptPlaceholder,
} from "@bb-native/app/components/promptbox/follow-up-placeholder";
import {
  makeTypeaheadConfig,
  makeAttachmentsConfig,
  makeExecutionControlsProps,
  useInteractiveExecutionControls,
} from "@bb-native/ladle/story-fixtures";
import { WithDesktopBrowser } from "@bb-native/ladle/story-desktop";
import {
  applyAppFrameGeometry,
  getBbDesktopInfo,
  MACOS_TITLE_BAR_CONTROL_AXIS_CLASS,
  MACOS_TITLE_BAR_CONTROL_SIZE_CLASS,
  MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS,
} from "@bb-native/app/lib/bb-desktop";
import { setPreferredTheme } from "@bb-native/app/hooks/useTheme";
import { getPluginConfigurationRoutePath } from "@bb-native/app/lib/route-paths";
import "@bb-native/ladle/composer-plugin";
import "virtual:bb-native-style.css";
import "./native-frame.css";
import { useNativeSlot } from "./native-slot.jsx";
import { secondaryPanelWidthPercentAtom } from "./native-panel-state.jsx";

const noop = () => {};
const threadId = "thr_storybook_native";
const threadTitle = "Keep reviews available offline";
const settingsPluginId = "agent-instructions";
const settingsSearchConditions = new Set(
  /** @type {import("@bb-native/app/components/settings/settings-search").SettingsSearchCondition[]} */ ([
    "cliCommand",
    "desktopBrowser",
    "filePreferences",
    "performanceDiagnostics",
  ]),
);

function RailButton({ name, label, active = false }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={SIDEBAR_RAIL_BUTTON_CLASS}
        >
          <Icon name={name} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NativeSidebar({ context, slot }) {
  const threads = [threadTitle, "Check the release candidate", "Improve keyboard navigation"];
  return (
    <Sidebar>
      <div className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]">
        <nav
          aria-label="Navigation"
          className={`relative z-10 flex min-h-0 flex-col items-center pt-2.5 ${NAV_RAIL_WIDTH_CLASS}`}
        >
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto py-0.5">
            <RailButton name="Home" label="Home" />
            <RailButton name="Search" label="Search threads" />
            <RailButton
              name="FolderGit"
              label="Projects"
              active={context.placement === "page" || context.placement === "page-panel"}
            />
            <RailButton name="Plug02" label="Installed plugins" />
            <RailButton name="MoreHorizontal" label="More" />
          </div>
          <div className="flex h-(--bb-app-chrome-row-height) shrink-0 items-center justify-center">
            <RailButton name="Settings" label="Settings" />
          </div>
        </nav>
        <SidebarCollapsibleBody className="col-start-2 row-start-1 row-span-2">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <SidebarTopReserveRow
              testId="native-sidebar-top"
              headerSlot={
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className={PROJECT_LIST_ACTION_BUTTON_CLASS}
                >
                  <Icon name="MessageSquarePlus" />
                  <span className="min-w-0 flex-1 truncate text-left">New thread</span>
                </Button>
              }
            />
            <SidebarContent>
              {context.placement === "sidebar" ? (
                slot
              ) : (
                <div className="px-2 pt-2">
                  <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">
                    bb-plugins
                  </div>
                  <SidebarMenu>
                    {threads.map((label, index) => (
                      <SidebarMenuItem key={label}>
                        <SidebarMenuButton
                          aria-current={index === 0 ? "page" : undefined}
                          className={
                            index === 0 ? "bg-sidebar-accent text-sidebar-foreground" : undefined
                          }
                        >
                          <Icon name="MessageSquare" />
                          <ThreadTitle title={label} className="truncate" />
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ))}
                  </SidebarMenu>
                </div>
              )}
            </SidebarContent>
            <SidebarFooter className="h-(--bb-app-chrome-row-height) flex-row items-center justify-start gap-0.5 py-0 pl-(--bb-frame-footer-inset)">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SIDEBAR_FOOTER_ACTION_CLASS}
                aria-label="Mobile"
              >
                <Icon name="Smartphone" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SIDEBAR_FOOTER_ACTION_CLASS}
                aria-label="Report a bug"
              >
                <Icon name="Bug" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={SIDEBAR_FOOTER_ACTION_CLASS}
                aria-label="More sidebar actions"
              >
                <Icon name="MoreHorizontal" />
              </Button>
            </SidebarFooter>
          </div>
        </SidebarCollapsibleBody>
      </div>
    </Sidebar>
  );
}

function NativeTitlebar() {
  const isFramed = useIsSidebarFramed();
  return (
    <div
      className={`sb-native-titlebar pointer-events-none absolute left-0 top-0 z-50 flex h-(--bb-window-title-bar-height) items-center pl-(--bb-macos-traffic-light-reserve) ${MACOS_TITLE_BAR_CONTROL_AXIS_CLASS} ${MACOS_TITLE_BAR_CONTROL_SIZE_CLASS}`}
    >
      <div className="pointer-events-auto flex items-center gap-(--bb-title-bar-sidebar-toggle-gap)">
        {isFramed ? <SidebarHistoryNavigationControls className="gap-0" /> : null}
        <SidebarTrigger aria-label="Toggle sidebar" />
      </div>
    </div>
  );
}

/** @param {{ slot?: import("react").ReactNode, placement?: string }} props */
function NativeConversation({ slot = null, placement = "thread-panel" }) {
  const draft = useStoryPromptDraft();
  const typeahead = useMemo(() => makeTypeaheadConfig(), []);
  const attachments = useMemo(() => makeAttachmentsConfig(), []);
  const baseExecution = useMemo(() => makeExecutionControlsProps(), []);
  const execution = useInteractiveExecutionControls(baseExecution);
  const [permission, setPermission] = useState(
    /** @type {import("@bb-native/app/components/promptbox/ExecutionControls").ExecutionPermissionConfig["value"]} */ (
      "auto"
    ),
  );
  const footer = (
    <div className="relative bg-background">
      <div className="mx-auto w-full max-w-[760px] px-4 pb-4 pt-2">
        <FollowUpPromptBox
          attachments={attachments}
          stack={placement === "composer" ? slot : null}
          composer={{
            history: {
              currentDraft: { text: draft.text, mentions: draft.mentionRanges, attachments: [] },
              entries: [],
              onSelectEntry: noop,
            },
            isFollowUpSubmitting: false,
            message: draft.text,
            mentionRanges: draft.mentionRanges,
            onChangeMessage: draft.onChange,
            onModifierSubmit: noop,
            onSubmit: noop,
            compactPromptPlaceholder: getCompactFollowUpPromptPlaceholder("idle"),
            promptPlaceholder: getFollowUpPromptPlaceholder("idle"),
            canModifierSubmit: false,
            steerActiveThreadOnEnter: false,
            submitMode: { kind: "ready" },
            threadRuntimeDisplayStatus: "idle",
          }}
          environmentSummary={null}
          contextWindowUsage={null}
          execution={execution}
          permission={{
            value: permission,
            options: [
              { value: "accept-edits", label: "Accept Edits" },
              { value: "auto", label: "Approve for me" },
              { value: "full", label: "Full Access", tone: "warning" },
            ],
            onChange: setPermission,
            supported: true,
          }}
          typeahead={typeahead}
          collapseResetKey={threadId}
          isPrimaryComposer={false}
        />
      </div>
    </div>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-thread-window="">
      <BottomAnchoredScrollBody
        footer={footer}
        maxWidthClassName="max-w-[760px]"
        contentClassName="!pb-3 !pt-4"
        scrollAnchorThreadId={threadId}
      >
        <div className="space-y-5">
          <ConversationMessageContent
            {...{ role: "user" }}
            text="Keep the review available while the checkout reconnects."
            timestamp={0}
            attachments={null}
            initiator="user"
            mentions={[]}
            senderThreadId={null}
            senderThreadTitle={null}
            senderIsPluginSideChat={false}
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            turnRequest={{ kind: "message", status: "accepted", isGrouped: false }}
          />
          <ConversationMessageContent
            {...{ role: "assistant" }}
            text="The last successful snapshot stays visible while the host reconnects. Here is the current work for review."
            timestamp={0}
            attachments={null}
            id="message_storybook_native"
            threadId={threadId}
            turnId="turn_storybook_native"
            showActions={false}
            mobileActionDisplay="overflow"
            streaming={false}
          />
          {["message", "overlay"].includes(placement) ? slot : null}
        </div>
      </BottomAnchoredScrollBody>
    </div>
  );
}

function NativePanel({ context, slot }) {
  const [open, setOpen] = useState(true);
  const tab = useMemo(
    () =>
      createPluginPanelFixedPanelTab({
        pluginId: "storybook",
        actionId: "preview",
        paramsJson: null,
        title: context.tab ?? context.title,
      }),
    [context.tab, context.title],
  );
  const tabs = useMemo(
    () => [
      {
        label: context.tab ?? context.title,
        tab,
        leadingVisual: <Icon name="File" />,
        statusLabel: null,
        onClose: () => setOpen(false),
        onSelect: () => setOpen(true),
        renderContent: () => slot,
        contentFillsRegion: true,
      },
    ],
    [context, tab, slot],
  );
  const main =
    context.placement === "page-panel" ? (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Select a document to preview
      </div>
    ) : (
      <NativeConversation />
    );
  return (
    <SecondaryPanelLayout
      open={open}
      onToggle={() => setOpen(!open)}
      onClose={() => setOpen(false)}
      onSwipeOpen={() => setOpen(true)}
      resetKey="storybook"
      contentKey={tab.id}
      drawerLabel={context.tab ?? context.title}
      drawerFallback={null}
      mainPanelId="storybook-main"
      composerHost={null}
      mainHeader={
        <AppPageHeader
          center={
            <ThreadTitle
              title={context.placement === "page-panel" ? context.title : threadTitle}
              className="truncate text-sm font-normal"
            />
          }
          actions={
            <Button
              variant="ghost"
              size="icon"
              className={`${HEADER_ICON_BUTTON_CLASS} ${MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS}`}
              aria-label="Toggle preview panel"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <Icon name="PanelRight" />
            </Button>
          }
        />
      }
      main={main}
      renderPanel={({ presentation, resizablePanelId }) => (
        <ThreadSecondaryPanel
          activeTab={tab}
          canUseGitUi={false}
          isOpen={open}
          metadataContent={null}
          fixedTabs={[]}
          tabs={tabs}
          onPanelFocus={noop}
          onCollapse={() => setOpen(false)}
          onClose={() => setOpen(false)}
          onTabReorder={noop}
          onOpenNewTab={noop}
          isConversationCollapsed={false}
          onToggleConversationCollapse={noop}
          renderAsDrawer={presentation === "drawer"}
          resizablePanelId={resizablePanelId}
          showNewTabButton={false}
          showConversationCollapseControl={false}
          inlinePanelToggle="hidden"
        />
      )}
    />
  );
}

function NativeSettings({ context, slot }) {
  return (
    <>
      <Sidebar>
        <SidebarCollapsibleBody contentInFlow>
          <SettingsSidebarContent
            backTo={null}
            isResizing={false}
            onResizeMouseDown={noop}
            navigation={{
              activePluginId: settingsPluginId,
              activeSection: null,
              pluginEntries: [
                { id: settingsPluginId, label: context.title, icon: null, hasSettingsForm: false },
              ],
              sections: SETTINGS_NAV_SECTIONS,
            }}
            pluginSettingSearch={{ entries: [], isLoading: false, onActivate: noop }}
            searchConditions={settingsSearchConditions}
            testIdPrefix="native-settings"
          />
        </SidebarCollapsibleBody>
      </Sidebar>
      <SidebarInset>
        <AppPageHeader center={<span className="truncate text-sm font-semibold">Settings</span>} />
        <div className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
          <PageShell contentClassName="pt-4 md:pt-5">
            <div className="space-y-6">
              <header className="flex min-w-0 items-start gap-3">
                <div className="size-9 shrink-0">
                  <PluginIcon pluginId={settingsPluginId} icon={null} className="size-full" />
                </div>
                <div className="min-w-0">
                  <h1 className="truncate text-lg font-semibold text-foreground">
                    {context.title}
                  </h1>
                </div>
              </header>
              {slot}
            </div>
          </PageShell>
        </div>
      </SidebarInset>
    </>
  );
}

function NativeDesktopFrame({ context, width, children, layout }) {
  const store = useMemo(() => {
    const next = createStore();
    next.set(secondaryPanelWidthPercentAtom, 50);
    return next;
  }, []);
  useLayoutEffect(() => {
    setPreferredTheme("dark");
    applyAppFrameGeometry(document.documentElement, getBbDesktopInfo());
  }, []);
  const { outlet: slot, portal } = useNativeSlot(children, width, context.placement, layout);
  const panel = ["thread-panel", "page-panel"].includes(context.placement);
  const main = panel ? (
    <NativePanel context={context} slot={slot} />
  ) : (
    <>
      <AppPageHeader
        center={
          <ThreadTitle
            title={context.placement === "page" ? context.title : threadTitle}
            className="truncate text-sm font-normal"
          />
        }
      />
      {context.placement === "page" ? (
        <main className="sb-native-page">{slot}</main>
      ) : (
        <>
          <NativeConversation slot={slot} placement={context.placement} />
        </>
      )}
    </>
  );
  return (
    <div
      className="sb-native-frame relative"
      data-native-bb=""
      data-placement={context.placement}
      data-width={width}
      data-layout={layout}
    >
      <MemoryRouter
        initialEntries={[
          context.placement === "settings"
            ? getPluginConfigurationRoutePath({ pluginId: settingsPluginId })
            : `/projects/proj_storybook/threads/${threadId}`,
        ]}
      >
        <RouteNavigationProvider>
          <JotaiProvider store={store}>
            <TooltipProvider>
              <SidebarProvider
                framed
                width="320px"
                collapsedRailWidth={
                  context.placement === "settings" ? undefined : NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH
                }
                className="h-full min-h-0"
                style={
                  context.placement === "sidebar"
                    ? /** @type {import("react").CSSProperties} */ ({
                        "--sidebar-width": "min(var(--sb-native-width), 40vw)",
                      })
                    : undefined
                }
              >
                {portal}
                <NativeTitlebar />
                {context.placement === "settings" ? (
                  <NativeSettings context={context} slot={slot} />
                ) : (
                  <>
                    <NativeSidebar context={context} slot={slot} />
                    <SidebarInset>{main}</SidebarInset>
                  </>
                )}
              </SidebarProvider>
            </TooltipProvider>
          </JotaiProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    </div>
  );
}

export default function NativeEditorFrame(props) {
  return (
    <WithDesktopBrowser>
      <NativeDesktopFrame {...props} />
    </WithDesktopBrowser>
  );
}
