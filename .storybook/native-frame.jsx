import { useLayoutEffect, useMemo, useState } from "react";
import { MemoryRouter } from "@bb-native/deps/react-router-dom";
import { Provider as JotaiProvider, createStore } from "@bb-native/deps/jotai";
import { TooltipProvider } from "@bb-native/deps/@bb/shared-ui/tooltip";
import { Button } from "@bb-native/deps/@bb/shared-ui/button";
import { Dialog, DialogContent, DialogTitle } from "@bb-native/deps/@bb/shared-ui/dialog";
import { Icon } from "@bb-native/deps/@bb/shared-ui/icon";
import { RouteNavigationProvider } from "@bb-native/app/components/ui/app-route-anchor";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@bb-native/app/components/ui/sidebar";
import { AppPageHeader } from "@bb-native/app/components/layout/AppPageHeader";
import { SecondaryPanelLayout } from "@bb-native/app/components/secondary-panel/SecondaryPanelLayout";
import { ThreadSecondaryPanel } from "@bb-native/app/components/secondary-panel/ThreadSecondaryPanel";
import { createPluginPanelFixedPanelTab } from "@bb-native/app/lib/fixed-panel-tabs-state";
import { ConversationMessageContent } from "@bb-native/app/components/thread/timeline/ConversationMessageContent";
import {
  StoryDraftPromptBox,
  useStoryPromptDraft,
} from "@bb-native/app/components/thread/timeline/StoryDraftPromptBox";
import { SettingsStoryChrome } from "@bb-native/ladle/story-settings-chrome";
import { setPreferredTheme } from "@bb-native/app/hooks/useTheme";
import "@bb-native/ladle/composer-plugin";
import "virtual:bb-native-style.css";
import "./native-frame.css";
import { useNativeSlot } from "./native-slot.jsx";
import { secondaryPanelWidthPercentAtom } from "./native-panel-state.jsx";

const noop = () => {};
const threadId = "thr_storybook_native";
const threadTitle = "Keep reviews available offline";

function NativeSidebar({ context, slot }) {
  const thread = !["page", "page-panel"].includes(context.placement);
  const items = thread
    ? [threadTitle, "Check the release candidate", "Improve keyboard navigation"]
    : [context.title, "Threads"];
  return (
    <Sidebar>
      <AppPageHeader
        center={<span className="font-semibold">bb</span>}
        actions={<SidebarTrigger />}
      />
      <SidebarContent>
        {context.placement === "sidebar" ? (
          slot
        ) : (
          <SidebarMenu>
            {items.map((label, index) => (
              <SidebarMenuItem key={label}>
                <SidebarMenuButton aria-current={index === 0 ? "page" : undefined}>
                  <Icon name={thread ? "MessageSquare" : "Folder"} />
                  <span className="truncate">{label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        )}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenuButton>
          <Icon name="Settings" />
          Settings
        </SidebarMenuButton>
      </SidebarFooter>
    </Sidebar>
  );
}

/** @param {{ slot?: import("react").ReactNode, placement?: string }} props */
function NativeConversation({ slot = null, placement = "thread-panel" }) {
  const draft = useStoryPromptDraft();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-3xl space-y-6">
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
      </div>
      <div className="shrink-0 p-4 md:p-5">
        {placement === "composer" ? slot : null}
        <StoryDraftPromptBox draft={draft} />
      </div>
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
      <div className="flex flex-1 items-center justify-center p-5 text-muted-foreground">
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
            <div className="flex items-center gap-2">
              <SidebarTrigger />
              <span className="truncate">
                {context.placement === "page-panel" ? context.title : threadTitle}
              </span>
            </div>
          }
          actions={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Toggle preview panel"
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

export default function NativeEditorFrame({ context, width, children }) {
  const store = useMemo(() => {
    const next = createStore();
    next.set(secondaryPanelWidthPercentAtom, 50);
    return next;
  }, []);
  useLayoutEffect(() => {
    setPreferredTheme("dark");
  }, []);
  const { outlet: slot, portal } = useNativeSlot(children, width, context.placement);
  const panel = ["thread-panel", "page-panel"].includes(context.placement);
  const main = panel ? (
    <NativePanel context={context} slot={slot} />
  ) : (
    <>
      <AppPageHeader
        center={
          <div className="flex items-center gap-2">
            <SidebarTrigger />
            <span>{context.placement === "page" ? context.title : threadTitle}</span>
          </div>
        }
      />
      {context.placement === "page" ? (
        <main className="sb-native-page">{slot}</main>
      ) : (
        <>
          <NativeConversation slot={slot} placement={context.placement} />
          {context.placement === "dialog" ? (
            <Dialog open>
              <DialogContent className="max-w-5xl">
                <DialogTitle>{context.title}</DialogTitle>
                {slot}
              </DialogContent>
            </Dialog>
          ) : null}
        </>
      )}
    </>
  );
  return (
    <div
      className="sb-native-frame"
      data-native-bb=""
      data-placement={context.placement}
      data-width={width}
    >
      <MemoryRouter
        initialEntries={[
          context.placement === "settings"
            ? "/settings/general"
            : `/projects/proj_storybook/threads/${threadId}`,
        ]}
      >
        <RouteNavigationProvider>
          <JotaiProvider store={store}>
            <TooltipProvider>
              {portal}
              {context.placement === "settings" ? (
                <SettingsStoryChrome contentOwnsPageShell>{slot}</SettingsStoryChrome>
              ) : (
                <SidebarProvider
                  className="h-full min-h-0"
                  style={
                    context.placement === "sidebar"
                      ? /** @type {import("react").CSSProperties} */ ({
                          "--sidebar-width": "min(var(--sb-native-width), 40vw)",
                        })
                      : undefined
                  }
                >
                  <NativeSidebar context={context} slot={slot} />
                  <SidebarInset>{main}</SidebarInset>
                </SidebarProvider>
              )}
            </TooltipProvider>
          </JotaiProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    </div>
  );
}
