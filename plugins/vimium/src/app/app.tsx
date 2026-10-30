import "./app.css";
import { useEffect } from "react";
import { toast } from "sonner";
import {
  definePluginApp,
  useBbNavigate,
  useComposer,
  useComposers,
  useSdk,
  useSidebarSplitLayout,
} from "@get-bb/plugin-sdk/app";
import { CheatsheetPage } from "./cheatsheet-page.tsx";
import { mountLinkHints, setBbNavigation } from "./link-hints.ts";

import {
  setProviderShortcuts,
  shortcutSelection,
  targetProvider,
  type ProviderShortcut,
} from "./provider-shortcuts.ts";

const CHEATSHEET_PATH = "cheatsheet";

/** Opens destinations that have no link on screen, through bb's own navigation. */
function NavigationBridge() {
  const navigate = useBbNavigate();
  const routeComposer = useComposer();
  const composers = useComposers();
  const routeScope = routeComposer.scope;
  const split = useSidebarSplitLayout();
  const focusedThreadId = split
    ? split.panes.find((pane) => pane.isFocused)?.threadId
    : routeScope.kind === "thread"
      ? routeScope.threadId
      : null;
  // The split SDK identifies thread panes; a null threadId can also be a plugin page.
  const composer =
    split && !focusedThreadId
      ? null
      : (composers.find((candidate) =>
          focusedThreadId
            ? candidate.scope.kind === "thread" && candidate.scope.threadId === focusedThreadId
            : candidate.scope.kind === "new-thread",
        ) ?? (split ? null : routeComposer));
  const sdk = useSdk();
  const scope = composer?.scope;
  useEffect(() => {
    if (!composer || !scope) return;
    let disposed = false;
    let activeTimeout: number | undefined;
    let pending = false;
    let activeController: AbortController | null = null;
    setProviderShortcuts((action: ProviderShortcut) => {
      const selection = composer.selection;
      if (!selection?.providerId || (scope.kind !== "thread" && scope.kind !== "new-thread"))
        return false;
      if (pending) return true;
      const providerId = action === "provider" ? targetProvider(selection) : selection.providerId;
      if (!providerId) return false;
      pending = true;
      const controller = new AbortController();
      activeController = controller;
      let timeout: number | undefined;
      const deadline = new Promise<never>((_, reject) => {
        activeTimeout = timeout = window.setTimeout(() => {
          controller.abort();
          reject(new Error("Provider shortcut timed out. Try again."));
        }, 15_000);
      });
      const apply = async () => {
        const environment = selection.environment;
        const routing =
          scope.kind === "thread"
            ? {
                environmentId:
                  (await sdk.threads.get({ threadId: scope.threadId })).environmentId ?? undefined,
              }
            : environment?.type === "reuse"
              ? { environmentId: environment.environmentId }
              : environment?.type === "host" && environment.hostId
                ? { hostId: environment.hostId, projectId: selection.projectId }
                : environment?.type === "provider" && environment.machine?.type === "existing"
                  ? { hostId: environment.machine.hostId, projectId: selection.projectId }
                  : { projectId: selection.projectId };
        if (controller.signal.aborted) return;
        const catalog = await sdk.providers.models({
          ...routing,
          providerId,
          signal: controller.signal,
        });
        if (catalog.modelLoadError)
          throw new Error(catalog.modelLoadError.detail ?? "Could not load provider models");
        // Selection writes belong to the original visible composer and snapshot.
        if (
          controller.signal.aborted ||
          composer.selection?.providerId !== selection.providerId ||
          composer.selection?.model !== selection.model ||
          composer.selection?.reasoningLevel !== selection.reasoningLevel ||
          composer.selection?.serviceTier !== selection.serviceTier ||
          composer.selection?.projectId !== selection.projectId ||
          JSON.stringify(composer.selection?.environment) !== JSON.stringify(selection.environment)
        )
          return;
        const models =
          action === "provider"
            ? catalog.models
            : [...catalog.models, ...catalog.selectedOnlyModels];
        const next = shortcutSelection(action, selection, models);
        if (next) await composer.setSelection(next);
      };
      void Promise.race([apply(), deadline])
        .catch((error: unknown) => {
          if (disposed) return;
          toast.error(
            error instanceof Error ? error.message : "Could not update provider settings",
          );
        })
        .finally(() => {
          window.clearTimeout(timeout);
          pending = false;
        });
      return true;
    });
    return () => {
      disposed = true;
      window.clearTimeout(activeTimeout);
      activeController?.abort();
      setProviderShortcuts(null);
    };
  }, [composer, sdk, scope]);
  useEffect(() => {
    setBbNavigation({
      openThread: (threadId) => navigate.toThread(threadId),
      // Pressed on the page itself, `?` must not stack a duplicate history entry.
      openCheatsheet: () =>
        navigate.toPluginPanel(CHEATSHEET_PATH, {
          replace: window.location.pathname.endsWith(`/${CHEATSHEET_PATH}`),
        }),
    });
    return () => setBbNavigation(null);
  }, [navigate]);
  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "thread-navigation", component: NavigationBridge });
  app.slots.navPanel({
    id: "cheatsheet",
    title: "Vimium Cheatsheet",
    icon: "vimium/plugin",
    path: CHEATSHEET_PATH,
    component: CheatsheetPage,
  });
  app.contentScripts.register({
    id: "link-hints",
    mount: mountLinkHints,
  });
});
