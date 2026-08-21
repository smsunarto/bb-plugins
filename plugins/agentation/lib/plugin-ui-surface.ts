// Attribute an element to the public bb plugin UI API that put it on screen.
//
// bb deliberately exposes only plugin ownership in the DOM. The exact slot
// identity lives on the React boundary that contains every plugin component as
// `pluginId`, `slotKind`, and `slotId`. Agentation already walks React fibers to
// record component paths, so reading that boundary here uses the same
// best-effort diagnostic seam and lets annotations name the SDK surface an
// agent should inspect instead of the old catch-all `inline` label.

import { panelPluginIdFromRoute } from "./route.ts";

export interface PluginUiSurfaceContext {
  pluginId: string | null;
  surface: string | null;
}

/**
 * bb's renderer names its component boundaries without experimental prefixes
 * or registration member names. Keep the translation beside the annotation
 * code so the stored value matches the public SDK API shown to plugin authors.
 */
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

type ReactFiber = {
  memoizedProps?: unknown;
  return?: ReactFiber | null;
};

type PluginRecord = {
  pluginId: string;
  id?: string;
  key?: string;
  label?: string;
  title?: string;
};

const REACT_FIBER_PREFIXES = ["__reactFiber$", "__reactInternalInstance$"] as const;
const MAX_FIBER_DEPTH = 80;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function fiberFromElement(element: Element): ReactFiber | null {
  let node: Element | null = element;
  while (node) {
    const key = Object.keys(node).find((candidate) =>
      REACT_FIBER_PREFIXES.some((prefix) => candidate.startsWith(prefix)),
    );
    if (key) {
      const fiber = (node as unknown as Record<string, unknown>)[key];
      if (typeof fiber === "object" && fiber !== null) return fiber as ReactFiber;
    }
    node = node.parentElement;
  }
  return null;
}

function publicSurface(slotKind: string): string {
  return PUBLIC_SURFACE_BY_SLOT_KIND[
    slotKind as keyof typeof PUBLIC_SURFACE_BY_SLOT_KIND
  ] ?? slotKind;
}

/** The nearest bb plugin component boundary in this element's React ancestry. */
function componentBoundaryFor(element: Element): PluginUiSurfaceContext | null {
  let fiber = fiberFromElement(element);
  let depth = 0;
  while (fiber && depth < MAX_FIBER_DEPTH) {
    const props = asRecord(fiber.memoizedProps);
    const pluginId = nonEmptyString(props?.pluginId);
    const slotKind = nonEmptyString(props?.slotKind);
    if (pluginId && slotKind) {
      return { pluginId, surface: publicSurface(slotKind) };
    }
    fiber = fiber.return ?? null;
    depth += 1;
  }
  return null;
}

function pluginRecord(value: unknown): PluginRecord | null {
  const record = asRecord(value);
  const pluginId = nonEmptyString(record?.pluginId);
  if (!pluginId) return null;
  return {
    pluginId,
    ...(nonEmptyString(record?.id) ? { id: String(record?.id) } : {}),
    ...(nonEmptyString(record?.key) ? { key: String(record?.key) } : {}),
    ...(nonEmptyString(record?.label) ? { label: String(record?.label) } : {}),
    ...(nonEmptyString(record?.title) ? { title: String(record?.title) } : {}),
  };
}

/**
 * Host-rendered registrations do not get a plugin component boundary. Their
 * descriptor remains in an ancestor's props, so collect only direct records
 * and arrays from that ancestry; walking arbitrary object graphs would enter
 * React elements and application state.
 */
function pluginRecordsFromFiber(element: Element): PluginRecord[] {
  const records: PluginRecord[] = [];
  let fiber = fiberFromElement(element);
  let depth = 0;
  while (fiber && depth < MAX_FIBER_DEPTH) {
    const props = asRecord(fiber.memoizedProps);
    if (props) {
      for (const value of Object.values(props)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            const candidate = pluginRecord(item);
            if (candidate) records.push(candidate);
          }
          continue;
        }
        const candidate = pluginRecord(value);
        if (candidate) records.push(candidate);
      }
    }
    fiber = fiber.return ?? null;
    depth += 1;
  }
  return records;
}

function targetLabels(element: Element): Set<string> {
  const labels = new Set<string>();
  let node: Element | null = element;
  for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
    for (const value of [
      node.getAttribute("aria-label"),
      node.getAttribute("title"),
      node.textContent?.trim(),
    ]) {
      if (value) labels.add(value);
    }
    if (node.matches("button, [role='button'], [role='menuitem']")) break;
  }
  return labels;
}

function labelMatches(record: PluginRecord, labels: Set<string>): boolean {
  return [record.label, record.title].some(
    (candidate) => candidate !== undefined && labels.has(candidate),
  );
}

function hostRenderedActionFor(element: Element): PluginUiSurfaceContext | null {
  const labels = targetLabels(element);
  const records = pluginRecordsFromFiber(element);

  const footer = element.closest<HTMLElement>(
    "[data-testid^='plugin-sidebar-footer-action-']",
  );
  const footerTestId = footer?.getAttribute("data-testid") ?? null;
  if (footerTestId) {
    const action = records.find(
      (record) =>
        record.id !== undefined &&
        footerTestId === `plugin-sidebar-footer-action-${record.pluginId}-${record.id}`,
    );
    if (action) return { pluginId: action.pluginId, surface: "sidebarFooterAction" };
  }

  const panelAction = records.find(
    (record) =>
      record.id?.startsWith(`plugin-action:${record.pluginId}:`) === true &&
      labelMatches(record, labels),
  );
  if (panelAction) {
    return { pluginId: panelAction.pluginId, surface: "threadPanelAction.run" };
  }

  const newThreadPanelAction = records.find(
    (record) =>
      record.id?.startsWith(`plugin-new-thread-action:${record.pluginId}:`) === true &&
      labelMatches(record, labels),
  );
  if (newThreadPanelAction) {
    return {
      pluginId: newThreadPanelAction.pluginId,
      surface: "experimental_newThreadPanelAction.run",
    };
  }

  // Registered message actions retain a `<plugin>/<action>/<generation>` key
  // in both the message bar and its portalled selected-text menu.
  // Consumer-supplied ThreadChat actions use `consumer/…` keys and correctly
  // remain attributed to their enclosing slot.
  const messageAction = records.find(
    (record) =>
      record.key?.startsWith(`${record.pluginId}/`) === true &&
      record.key.split("/").length === 3 &&
      labelMatches(record, labels),
  );
  if (messageAction) {
    return { pluginId: messageAction.pluginId, surface: "messageAction" };
  }

  return null;
}

function pluginIdFromAssetUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  const match = /\/api\/v1\/plugins\/([^/]+)\/assets(?:[/?#]|$)/.exec(rawUrl);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function navPanelRowFor(element: Element): PluginUiSurfaceContext | null {
  if (!element.closest("[data-testid='plugin-nav-sidebar-items']")) return null;
  const row =
    element.closest(".bb-sidebar-hover-actions-row") ??
    element.closest("button, a, [role='button']") ??
    element;
  const icon = row.querySelector<HTMLElement>("[data-plugin-icon-asset]");
  const pluginId = pluginIdFromAssetUrl(icon?.getAttribute("data-plugin-icon-asset") ?? null);
  return pluginId ? { pluginId, surface: "navPanel" } : null;
}

/**
 * Which bb plugin UI surface an element belongs to.
 *
 * Exact SDK registrations win. The final `overlay` / `navPanel` / `inline`
 * fallbacks preserve attribution for hand-written trusted content and future
 * bb surfaces that do not yet expose a component boundary.
 */
export function pluginUiSurfaceFor(
  element: Element | null,
  route: string,
): PluginUiSurfaceContext {
  if (!element) return { pluginId: null, surface: null };

  const boundary = componentBoundaryFor(element);
  if (boundary) return boundary;

  const richTextDecoration = element.closest<HTMLElement>("[data-bb-plugin-decoration]");
  const richTextPluginId = richTextDecoration?.getAttribute("data-bb-plugin-decoration") ?? null;
  if (richTextPluginId) {
    return { pluginId: richTextPluginId, surface: "composer.richText" };
  }

  const composerAction = element.closest<HTMLElement>("[data-plugin-composer-action-plugin]");
  const composerActionPluginId =
    composerAction?.getAttribute("data-plugin-composer-action-plugin") ?? null;
  if (composerActionPluginId) {
    return { pluginId: composerActionPluginId, surface: "composer.actions" };
  }

  const hostAction = hostRenderedActionFor(element);
  if (hostAction) return hostAction;

  const navRow = navPanelRowFor(element);
  if (navRow) return navRow;

  const owner = element.closest<HTMLElement>("[data-bb-plugin]");
  const pluginId = owner?.getAttribute("data-bb-plugin") ?? null;
  if (!pluginId) return { pluginId: null, surface: null };

  if (element.closest("[data-testid='app-page-header-content-row']")) {
    return { pluginId, surface: "navPanel.headerContent" };
  }
  if (element.closest("[data-bb-portaled-overlay]")) {
    return { pluginId, surface: "overlay" };
  }
  if (panelPluginIdFromRoute(route) === pluginId) {
    return { pluginId, surface: "navPanel" };
  }
  return { pluginId, surface: "inline" };
}
