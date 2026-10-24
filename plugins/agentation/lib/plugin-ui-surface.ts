// Attribute an element to the public bb plugin UI API that put it on screen.
//
// bb deliberately exposes only plugin ownership in the DOM. The exact slot
// identity lives on the React boundary that contains every plugin component as
// `pluginId`, `slotKind`, and `slotId`. Agentation already walks React fibers to
// record component paths, so reading that boundary here uses the same
// best-effort diagnostic seam and lets annotations name the SDK surface an
// agent should inspect instead of the old catch-all `inline` label.

import { panelPluginIdFromRoute } from "./route.ts";
import { PUBLIC_SURFACE_BY_SLOT_KIND, WRAPPER_SLOT_KINDS } from "./plugin-ui-surface-map.ts";

export interface PluginUiSurfaceContext {
  pluginId: string | null;
  surface: string | null;
  surfaceId: string | null;
  /**
   * The sidebar navigation row (`<pluginId>/<panelId>` or `__bb__/…`) when a
   * navigation plugin drew the element. The row's entry belongs to another
   * plugin's `navPanel`, so the agent needs both owners.
   */
  navigationItemId?: string;
}

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
/** The owner bb gives its own entries in the shared thread action registry. */
const CORE_THREAD_ACTION_OWNER = "bb--core";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
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
  return (
    PUBLIC_SURFACE_BY_SLOT_KIND[slotKind as keyof typeof PUBLIC_SURFACE_BY_SLOT_KIND] ?? slotKind
  );
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
 * A plugin's `experimental_threadAction` entry, as bb hands it to each menu row
 * and sidebar row button: `{ key: "<pluginId>/<id>", pluginId, group, action }`.
 * bb's own actions share the registry under a reserved owner and are skipped.
 */
function threadActionEntry(value: unknown): PluginUiSurfaceContext | null {
  const record = asRecord(value);
  const pluginId = nonEmptyString(record?.pluginId);
  const key = nonEmptyString(record?.key);
  if (!pluginId || !key || pluginId === CORE_THREAD_ACTION_OWNER) return null;
  if (typeof record?.group !== "string" || !nonEmptyString(asRecord(record.action)?.label)) {
    return null;
  }
  const prefix = `${pluginId}/`;
  const actionId = key.startsWith(prefix) ? nonEmptyString(key.slice(prefix.length)) : null;
  return actionId ? { pluginId, surface: "experimental_threadAction", surfaceId: actionId } : null;
}

interface ReactOwnership {
  /** The nearest bb plugin component boundary, if any. */
  boundary: PluginUiSurfaceContext | null;
  /** A plugin thread action drawn between the element and that boundary. */
  threadAction: PluginUiSurfaceContext | null;
  /**
   * Host-rendered registration descriptors between the element and that
   * boundary. Host-rendered registrations do not get a component boundary;
   * their descriptor remains in an ancestor's props, so collect only direct
   * records and arrays; walking arbitrary object graphs would enter React
   * elements and application state.
   */
  records: PluginRecord[];
}

/** Collect one fiber's direct plugin records; return a thread action entry among them. */
function collectFiberRecords(
  props: Record<string, unknown>,
  records: PluginRecord[],
): PluginUiSurfaceContext | null {
  let threadAction: PluginUiSurfaceContext | null = null;
  for (const value of Object.values(props)) {
    const items = Array.isArray(value) ? value : [value];
    if (!Array.isArray(value)) threadAction ??= threadActionEntry(value);
    for (const item of items) {
      const candidate = pluginRecord(item);
      if (candidate) records.push(candidate);
    }
  }
  return threadAction;
}

/**
 * Walk the element's React ancestry to the nearest plugin component boundary.
 * Host-rendered items another plugin draws, such as thread actions in the
 * Thread List plugin's menus or message actions in a side chat, sit inside
 * the drawing plugin's boundary, so what the walk meets first wins.
 */
function reactOwnershipFor(element: Element): ReactOwnership {
  const records: PluginRecord[] = [];
  let threadAction: PluginUiSurfaceContext | null = null;
  let fiber = fiberFromElement(element);
  let depth = 0;
  while (fiber && depth < MAX_FIBER_DEPTH) {
    const props = asRecord(fiber.memoizedProps);
    const pluginId = nonEmptyString(props?.pluginId);
    const slotKind = nonEmptyString(props?.slotKind);
    if (pluginId && slotKind && !WRAPPER_SLOT_KINDS.has(slotKind)) {
      return {
        boundary: {
          pluginId,
          surface: publicSurface(slotKind),
          surfaceId: nonEmptyString(props?.slotId),
        },
        threadAction,
        records,
      };
    }
    if (props) {
      const found = collectFiberRecords(props, records);
      threadAction ??= found;
    }
    fiber = fiber.return ?? null;
    depth += 1;
  }
  return { boundary: null, threadAction, records };
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

function prefixedRegistrationId(record: PluginRecord, prefix: string): string | null {
  const expectedPrefix = `${prefix}:${record.pluginId}:`;
  return record.id?.startsWith(expectedPrefix)
    ? nonEmptyString(record.id.slice(expectedPrefix.length))
    : null;
}

function hostRenderedActionFor(
  element: Element,
  records: readonly PluginRecord[],
): PluginUiSurfaceContext | null {
  const labels = targetLabels(element);

  const footer = element.closest<HTMLElement>("[data-testid^='plugin-sidebar-footer-action-']");
  const footerTestId = footer?.getAttribute("data-testid") ?? null;
  if (footerTestId) {
    const action = records.find(
      (record) =>
        record.id !== undefined &&
        footerTestId === `plugin-sidebar-footer-action-${record.pluginId}-${record.id}`,
    );
    if (action) {
      return {
        pluginId: action.pluginId,
        surface: "sidebarFooterAction",
        surfaceId: action.id ?? null,
      };
    }
  }

  const panelAction = records.find(
    (record) =>
      record.id?.startsWith(`plugin-action:${record.pluginId}:`) === true &&
      labelMatches(record, labels),
  );
  if (panelAction) {
    return {
      pluginId: panelAction.pluginId,
      surface: "experimental_tab.run",
      surfaceId: prefixedRegistrationId(panelAction, "plugin-action"),
    };
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
      surfaceId: prefixedRegistrationId(newThreadPanelAction, "plugin-new-thread-action"),
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
    return {
      pluginId: messageAction.pluginId,
      surface: "messageAction",
      surfaceId: messageAction.key?.split("/")[1] ?? null,
    };
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

/**
 * A nav panel's `headerContent`. bb draws it in the page chrome, outside every
 * component boundary, under a host component that holds the panel record.
 */
function navPanelHeaderFor(element: Element, pluginId: string): PluginUiSurfaceContext | null {
  let fiber = fiberFromElement(element);
  let depth = 0;
  while (fiber && depth < MAX_FIBER_DEPTH) {
    const panel = asRecord(asRecord(fiber.memoizedProps)?.panel);
    if (panel?.pluginId === pluginId && panel.headerContent != null) {
      return { pluginId, surface: "navPanel.headerContent", surfaceId: nonEmptyString(panel.id) };
    }
    fiber = fiber.return ?? null;
    depth += 1;
  }
  return null;
}

/** Host-rendered sidebar rows from bb before 0.44, which had no navigation plugin. */
function navPanelRowFor(element: Element): PluginUiSurfaceContext | null {
  if (!element.closest("[data-testid='plugin-nav-sidebar-items']")) return null;
  const row =
    element.closest(".bb-sidebar-hover-actions-row") ??
    element.closest("button, a, [role='button']") ??
    element;
  const icon = row.querySelector<HTMLElement>("[data-plugin-icon-asset]");
  const pluginId = pluginIdFromAssetUrl(icon?.getAttribute("data-plugin-icon-asset") ?? null);
  return pluginId ? { pluginId, surface: "navPanel", surfaceId: null } : null;
}

/**
 * Which bb plugin UI surface an element belongs to.
 *
 * On bb 0.44+ the sidebar thread list and navigation are plugins (bundled
 * `thread-list` / `navigation`, or an installed replacement), so their rows
 * resolve through the component boundary like any other slot.
 *
 * Exact SDK registrations win. The final `overlay` / `navPanel` / `inline`
 * fallbacks preserve attribution for hand-written trusted content and future
 * bb surfaces that do not yet expose a component boundary.
 */
export function pluginUiSurfaceFor(element: Element | null, route: string): PluginUiSurfaceContext {
  if (!element) return { pluginId: null, surface: null, surfaceId: null };

  // Decorations paint text inside the composer, which bb 0.47 draws as its
  // bundled Composer plugin, so the marker is always nearer than a boundary.
  const richTextDecoration = element.closest<HTMLElement>("[data-bb-plugin-decoration]");
  const richTextPluginId = richTextDecoration?.getAttribute("data-bb-plugin-decoration") ?? null;
  if (richTextPluginId) {
    return { pluginId: richTextPluginId, surface: "composer.richText", surfaceId: null };
  }

  const { boundary, threadAction, records } = reactOwnershipFor(element);
  if (threadAction) return threadAction;

  const hostAction = hostRenderedActionFor(element, records);
  if (hostAction) return hostAction;

  if (boundary?.surface === PUBLIC_SURFACE_BY_SLOT_KIND.sidebarNavigation) {
    // bb's bundled Navigation plugin marks each row; other navigation plugins
    // may not, and then only the drawing plugin is known.
    const row = element.closest<HTMLElement>("[data-sidebar-navigation-item]");
    const navigationItemId = nonEmptyString(row?.getAttribute("data-sidebar-navigation-item"));
    return navigationItemId ? { ...boundary, navigationItemId } : boundary;
  }
  if (boundary) return boundary;

  const composerAction = element.closest<HTMLElement>("[data-plugin-composer-action-plugin]");
  const composerActionPluginId =
    composerAction?.getAttribute("data-plugin-composer-action-plugin") ?? null;
  if (composerActionPluginId) {
    return { pluginId: composerActionPluginId, surface: "composer.actions", surfaceId: null };
  }

  const navRow = navPanelRowFor(element);
  if (navRow) return navRow;

  const owner = element.closest<HTMLElement>("[data-bb-plugin]");
  const pluginId = owner?.getAttribute("data-bb-plugin") ?? null;
  if (!pluginId) return { pluginId: null, surface: null, surfaceId: null };

  const header = navPanelHeaderFor(element, pluginId);
  if (header) return header;
  if (element.closest("[data-bb-portaled-overlay]")) {
    return { pluginId, surface: "overlay", surfaceId: null };
  }
  if (panelPluginIdFromRoute(route) === pluginId) {
    return { pluginId, surface: "navPanel", surfaceId: null };
  }
  return { pluginId, surface: "inline", surfaceId: null };
}
