import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createInAppBrowserTab,
  hasAnyModifierKey,
  openBrowserTabInPanelState,
  panelStorageKey,
  parsePanelState,
  serializePanelState,
  shouldDeferToSystemBrowser,
  upsertBrowserTab,
} from "../lib/open-in-app-browser.ts";

describe("hasAnyModifierKey", () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

  it("is false with no modifiers", () => {
    assert.equal(hasAnyModifierKey(none), false);
  });

  it("is true for alt, ctrl, meta, or shift", () => {
    assert.equal(hasAnyModifierKey({ ...none, altKey: true }), true);
    assert.equal(hasAnyModifierKey({ ...none, ctrlKey: true }), true);
    assert.equal(hasAnyModifierKey({ ...none, metaKey: true }), true);
    assert.equal(hasAnyModifierKey({ ...none, shiftKey: true }), true);
  });
});

describe("shouldDeferToSystemBrowser", () => {
  const none = { altKey: false, button: 0, ctrlKey: false, metaKey: false, shiftKey: false };

  it("keeps a plain left click for the in-app browser", () => {
    assert.equal(shouldDeferToSystemBrowser(none), false);
  });

  it("defers a modifier click and a non-left click", () => {
    assert.equal(shouldDeferToSystemBrowser({ ...none, metaKey: true }), true);
    assert.equal(shouldDeferToSystemBrowser({ ...none, button: 1 }), true);
  });
});

describe("panelStorageKey", () => {
  it("matches bb's per-thread panel blob key", () => {
    assert.equal(
      panelStorageKey("thr_1"),
      "bb.thread.fixedPanelTabsState-thr_1-1",
    );
    assert.equal(
      panelStorageKey("thr/1"),
      "bb.thread.fixedPanelTabsState-thr%2F1-1",
    );
  });
});

describe("createInAppBrowserTab", () => {
  it("builds a host-shaped browser tab id", () => {
    const tab = createInAppBrowserTab({
      environmentId: "env_1",
      instanceId: "abc",
      title: " Fix login ",
      url: "https://github.com/acme/app/pull/12",
    });
    assert.deepEqual(tab, {
      environmentId: "env_1",
      id: "browser:abc:env_1",
      kind: "browser",
      title: "Fix login",
      url: "https://github.com/acme/app/pull/12",
    });
  });

  it("uses none when the thread has no environment", () => {
    const tab = createInAppBrowserTab({
      environmentId: null,
      instanceId: "abc",
      title: "",
      url: "https://example.com",
    });
    assert.equal(tab.id, "browser:abc:none");
    assert.equal(tab.title, "Pull request");
  });
});

describe("upsertBrowserTab", () => {
  it("reuses a tab that already has the URL", () => {
    const existing = {
      environmentId: null,
      id: "browser:old:none",
      kind: "browser" as const,
      title: "Old",
      url: "https://github.com/acme/app/pull/12",
    };
    const next = upsertBrowserTab(
      [existing],
      createInAppBrowserTab({
        environmentId: null,
        instanceId: "new",
        title: "New",
        url: existing.url,
      }),
    );
    assert.equal(next.tab, existing);
    assert.equal(next.tabs.length, 1);
  });

  it("appends when the URL is new", () => {
    const existing = {
      id: "thread-info:thread-info:none",
      kind: "thread-info",
    };
    const tab = createInAppBrowserTab({
      environmentId: null,
      instanceId: "new",
      title: "PR",
      url: "https://github.com/acme/app/pull/12",
    });
    const next = upsertBrowserTab([existing], tab);
    assert.equal(next.tab, tab);
    assert.deepEqual(next.tabs, [existing, tab]);
  });
});

describe("openBrowserTabInPanelState", () => {
  it("opens the panel onto the new tab", () => {
    const tab = createInAppBrowserTab({
      environmentId: null,
      instanceId: "abc",
      title: "PR",
      url: "https://github.com/acme/app/pull/12",
    });
    const { state } = openBrowserTabInPanelState(null, tab, 1_700_000_000_000);
    assert.equal(state.version, 1);
    assert.equal(state.lastUsedAt, 1_700_000_000_000);
    assert.equal(state.secondary.isOpen, true);
    assert.equal(state.secondary.activeTabId, tab.id);
    assert.deepEqual(state.secondary.tabs, [tab]);
  });

  it("round-trips through the host's storage JSON", () => {
    const tab = createInAppBrowserTab({
      environmentId: "env_1",
      instanceId: "abc",
      title: "PR",
      url: "https://github.com/acme/app/pull/12",
    });
    const { state } = openBrowserTabInPanelState(null, tab, 10);
    const parsed = parsePanelState(serializePanelState(state));
    assert.deepEqual(parsed, state);
  });

  it("rejects a blob that is not panel state", () => {
    assert.equal(parsePanelState("not-json"), null);
    assert.equal(parsePanelState("{}"), null);
  });
});
