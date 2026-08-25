import assert from "node:assert/strict";
import test from "node:test";

import { pluginUiSurfaceFor, PUBLIC_SURFACE_BY_SLOT_KIND } from "../lib/plugin-ui-surface.ts";

type Fiber = {
  memoizedProps?: unknown;
  return?: Fiber | null;
};

type FakeElementOptions = {
  attributes?: Record<string, string>;
  closest?: Record<string, FakeElement | null>;
  matches?: string[];
  parent?: FakeElement | null;
  queries?: Record<string, FakeElement | null>;
  text?: string;
};

class FakeElement {
  readonly attributes: Record<string, string>;
  readonly closestResults: Record<string, FakeElement | null>;
  readonly matchResults: Set<string>;
  readonly parentElement: FakeElement | null;
  readonly queryResults: Record<string, FakeElement | null>;
  readonly textContent: string;

  constructor(options: FakeElementOptions = {}) {
    this.attributes = options.attributes ?? {};
    this.closestResults = options.closest ?? {};
    this.matchResults = new Set(options.matches ?? []);
    this.parentElement = options.parent ?? null;
    this.queryResults = options.queries ?? {};
    this.textContent = options.text ?? "";
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  closest(selector: string): FakeElement | null {
    return this.closestResults[selector] ?? null;
  }

  matches(selector: string): boolean {
    return this.matchResults.has(selector);
  }

  querySelector(selector: string): FakeElement | null {
    return this.queryResults[selector] ?? null;
  }
}

function asElement(element: FakeElement): Element {
  return element as unknown as Element;
}

function withFiber(element: FakeElement, fiber: Fiber): FakeElement {
  Object.defineProperty(element, "__reactFiber$agentation-test", {
    configurable: true,
    enumerable: true,
    value: fiber,
  });
  return element;
}

const expectedBoundarySurfaces = {
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
};

test("every bb plugin component boundary maps to its public SDK surface", () => {
  assert.deepEqual(PUBLIC_SURFACE_BY_SLOT_KIND, expectedBoundarySurfaces);

  for (const [slotKind, surface] of Object.entries(expectedBoundarySurfaces)) {
    const target = withFiber(new FakeElement(), {
      return: {
        memoizedProps: { pluginId: "example-plugin", slotId: "example", slotKind },
      },
    });
    assert.deepEqual(pluginUiSurfaceFor(asElement(target), "/"), {
      pluginId: "example-plugin",
      surface,
      surfaceId: "example",
    });
  }
});

test("an unknown future component boundary remains useful without a code update", () => {
  const target = withFiber(new FakeElement(), {
    memoizedProps: {
      pluginId: "future-plugin",
      slotId: "preview",
      slotKind: "futurePreview",
    },
  });

  assert.deepEqual(pluginUiSurfaceFor(asElement(target), "/"), {
    pluginId: "future-plugin",
    surface: "futurePreview",
    surfaceId: "preview",
  });
});

test("composer paint and host-rendered actions carry their owning plugin", () => {
  const richText = new FakeElement({
    attributes: { "data-bb-plugin-decoration": "amp" },
  });
  richText.closestResults["[data-bb-plugin-decoration]"] = richText;
  assert.deepEqual(pluginUiSurfaceFor(asElement(richText), "/threads/thr_1"), {
    pluginId: "amp",
    surface: "composer.richText",
    surfaceId: null,
  });

  const composerAction = new FakeElement({
    attributes: { "data-plugin-composer-action-plugin": "review" },
  });
  composerAction.closestResults["[data-plugin-composer-action-plugin]"] = composerAction;
  assert.deepEqual(pluginUiSurfaceFor(asElement(composerAction), "/threads/thr_1"), {
    pluginId: "review",
    surface: "composer.actions",
    surfaceId: null,
  });
});

test("host-rendered action descriptors distinguish launchers, messages, and the footer", () => {
  const cases = [
    {
      element: withFiber(new FakeElement({ attributes: { "aria-label": "GitHub Stack" } }), {
        memoizedProps: {
          actions: [
            {
              id: "plugin-action:gh-stack:stack",
              pluginId: "gh-stack",
              title: "GitHub Stack",
            },
          ],
        },
      }),
      expected: {
        pluginId: "gh-stack",
        surface: "threadPanelAction.run",
        surfaceId: "stack",
      },
    },
    {
      element: withFiber(new FakeElement({ attributes: { "aria-label": "Plan work" } }), {
        memoizedProps: {
          actions: [
            {
              id: "plugin-new-thread-action:planner:plan",
              pluginId: "planner",
              title: "Plan work",
            },
          ],
        },
      }),
      expected: {
        pluginId: "planner",
        surface: "experimental_newThreadPanelAction.run",
        surfaceId: "plan",
      },
    },
    {
      element: withFiber(new FakeElement({ attributes: { "aria-label": "Send to inbox" } }), {
        memoizedProps: {
          pluginActions: [
            {
              key: "support/send-to-inbox/3",
              label: "Send to inbox",
              pluginId: "support",
            },
          ],
        },
      }),
      expected: {
        pluginId: "support",
        surface: "messageAction",
        surfaceId: "send-to-inbox",
      },
    },
  ] as const;

  for (const entry of cases) {
    assert.deepEqual(
      pluginUiSurfaceFor(asElement(entry.element), "/threads/thr_1"),
      entry.expected,
    );
  }

  const footer = withFiber(
    new FakeElement({
      attributes: {
        "aria-label": "Remote access",
        "data-testid": "plugin-sidebar-footer-action-connect-remote-access",
      },
    }),
    {
      memoizedProps: {
        actions: [{ id: "remote-access", pluginId: "connect", title: "Remote access" }],
      },
    },
  );
  footer.closestResults["[data-testid^='plugin-sidebar-footer-action-']"] = footer;
  assert.deepEqual(pluginUiSurfaceFor(asElement(footer), "/"), {
    pluginId: "connect",
    surface: "sidebarFooterAction",
    surfaceId: "remote-access",
  });
});

test("manual plugin roots retain precise header and route fallbacks", () => {
  const owner = new FakeElement({ attributes: { "data-bb-plugin": "notes" } });
  const header = new FakeElement();
  header.closestResults["[data-bb-plugin]"] = owner;
  header.closestResults["[data-testid='app-page-header-content-row']"] = header;
  assert.deepEqual(pluginUiSurfaceFor(asElement(header), "/plugins/notes/notes"), {
    pluginId: "notes",
    surface: "navPanel.headerContent",
    surfaceId: null,
  });

  const body = new FakeElement();
  body.closestResults["[data-bb-plugin]"] = owner;
  assert.deepEqual(pluginUiSurfaceFor(asElement(body), "/plugins/notes/notes"), {
    pluginId: "notes",
    surface: "navPanel",
    surfaceId: null,
  });

  assert.deepEqual(pluginUiSurfaceFor(null, "/"), {
    pluginId: null,
    surface: null,
    surfaceId: null,
  });
});
