import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "bun:test";
import { installDom } from "@bb-plugins/testing";

installDom();
const { mountPhoneDrawer } = await import("../lib/phone-drawer.ts");

// Each step is one task of bb's sidebar code; the observer sees its batch after.
const task = (mutate: () => void) => {
  mutate();
  return new Promise((resolve) => setTimeout(resolve, 0));
};

let inset: HTMLElement;
let openings: number;
let plays: number;
let controller: AbortController;

beforeEach(() => {
  inset = document.createElement("main");
  inset.setAttribute("data-sidebar", "inset");
  inset.setAttribute("data-sidebar-shelf", "closed");
  document.body.append(inset);
  openings = 0;
  plays = 0;
  controller = new AbortController();
  mountPhoneDrawer(document, controller.signal, {
    opening: () => openings++,
    opened: () => plays++,
  });
});

afterEach(() => {
  controller.abort();
  inset.remove();
});

const startSlide = () => inset.setAttribute("data-vaul-animate", "false");
// bb's inline styles: a finger drag, then a settle toward open (the drawer's width) or closed.
const drag = (px: number) => {
  inset.style.translate = `${px}px`;
  inset.style.transition = "none";
};
const settle = (px: number) => {
  inset.style.translate = `${px}px`;
  inset.style.transition = "translate 220ms ease";
};
const endSlide = () => inset.removeAttribute("data-vaul-animate");
const shelf = (state: "open" | "closed") => inset.setAttribute("data-sidebar-shelf", state);

it("starts opening when a tapped open starts sliding, and plays once it finishes", async () => {
  await task(startSlide);
  assert.deepEqual([openings, plays], [1, 0]);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.deepEqual([openings, plays], [1, 1]);
});

it("starts opening when a swipe starts, and plays when it settles open", async () => {
  await task(() => {
    shelf("open");
    startSlide();
  });
  assert.deepEqual([openings, plays], [1, 0]);
  await task(endSlide);
  assert.deepEqual([openings, plays], [1, 1]);
});

it("stays silent for a swipe that settles back closed", async () => {
  await task(() => {
    shelf("open");
    startSlide();
  });
  await task(() => {
    shelf("closed");
    endSlide();
  });
  assert.equal(plays, 0);
});

it("does nothing more when the open drawer is dragged and springs back", async () => {
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  await task(startSlide);
  await task(endSlide);
  assert.deepEqual([openings, plays], [1, 1]);
});

it("runs again on the next open after a close", async () => {
  await task(() => shelf("open"));
  await task(startSlide);
  await task(() => {
    shelf("closed");
    endSlide();
  });
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.deepEqual([openings, plays], [2, 2]);
});

it("stops observing once disposed", async () => {
  controller.abort();
  await task(() => shelf("open"));
  assert.deepEqual([openings, plays], [0, 0]);
});

it("follows a page that mounts after the script", async () => {
  inset.remove();
  const late = document.createElement("main");
  late.setAttribute("data-sidebar", "inset");
  document.body.append(late);
  late.setAttribute("data-sidebar-shelf", "closed");
  await task(() => late.setAttribute("data-vaul-animate", "false"));
  await task(() => {
    late.setAttribute("data-sidebar-shelf", "open");
    late.removeAttribute("data-vaul-animate");
  });
  assert.equal(plays, 1);
  late.remove();
});

it("dismisses the keyboard of a field on the page as the drawer opens", async () => {
  controller.abort();
  const own = new AbortController();
  mountPhoneDrawer(document, own.signal);
  const composer = document.createElement("textarea");
  inset.append(composer);
  composer.focus();
  assert.equal(document.activeElement, composer);
  await task(startSlide);
  assert.notEqual(document.activeElement, composer);
  own.abort();
});

it("leaves a field outside the page focused", async () => {
  controller.abort();
  const own = new AbortController();
  mountPhoneDrawer(document, own.signal);
  const search = document.createElement("input");
  document.body.append(search);
  search.focus();
  await task(startSlide);
  assert.equal(document.activeElement, search);
  search.remove();
  own.abort();
});

it("plays as a tapped open starts settling, not when it lands", async () => {
  await task(() => {
    startSlide();
    settle(300);
  });
  assert.deepEqual([openings, plays], [1, 1]);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.deepEqual([openings, plays], [1, 1]);
});

it("plays when a swipe is released toward open, not while it drags", async () => {
  await task(() => {
    shelf("open");
    startSlide();
    drag(40);
  });
  await task(() => drag(180));
  assert.equal(plays, 0);
  await task(() => settle(300));
  assert.equal(plays, 1);
  await task(endSlide);
  assert.equal(plays, 1);
});

it("stays silent for a swipe released back toward closed", async () => {
  await task(() => {
    shelf("open");
    startSlide();
    drag(60);
  });
  await task(() => settle(0));
  await task(() => {
    shelf("closed");
    endSlide();
  });
  assert.equal(plays, 0);
});

// The right panel: bb's full-screen shelf, and the page's slide toward it.
const mountPanel = (state: "full" | "closed" = "closed") => {
  const panel = document.createElement("div");
  panel.setAttribute("data-testid", "secondary-panel-shelf");
  panel.setAttribute("data-state", state);
  document.body.append(panel);
  return panel;
};
const panelState = (panel: HTMLElement, state: "full" | "closed") =>
  panel.setAttribute("data-state", state);
const clearSlide = () => {
  inset.style.translate = "";
  inset.style.transition = "";
};

it("starts opening and plays as a tap opens the right panel", async () => {
  const panel = mountPanel();
  await task(() => panelState(panel, "full"));
  assert.deepEqual([openings, plays], [1, 1]);
  panel.remove();
});

it("plays when a swipe toward the right panel is released, not while it drags", async () => {
  const panel = mountPanel();
  await task(() => drag(-40));
  assert.deepEqual([openings, plays], [1, 0]);
  await task(() => drag(-200));
  assert.equal(plays, 0);
  await task(() => settle(-390));
  assert.equal(plays, 1);
  // bb flips the panel open and clears the page's slide in one task.
  await task(() => {
    panelState(panel, "full");
    clearSlide();
  });
  assert.deepEqual([openings, plays], [1, 1]);
  panel.remove();
});

it("stays silent for a swipe toward the right panel released back", async () => {
  const panel = mountPanel();
  await task(() => drag(-60));
  await task(() => settle(0));
  await task(clearSlide);
  assert.deepEqual([openings, plays], [1, 0]);
  panel.remove();
});

it("does nothing more when the open right panel is dragged and springs back, and runs again after a close", async () => {
  const panel = mountPanel();
  await task(() => panelState(panel, "full"));
  await task(() => drag(-300));
  await task(() => settle(-390));
  await task(clearSlide);
  assert.deepEqual([openings, plays], [1, 1]);
  // A swipe that closes it: bb closes the panel as the settle starts.
  await task(() => drag(-200));
  await task(() => {
    settle(0);
    panelState(panel, "closed");
  });
  await task(clearSlide);
  await task(() => panelState(panel, "full"));
  assert.deepEqual([openings, plays], [2, 2]);
  panel.remove();
});

it("ignores the left drawer's slide for the right panel", async () => {
  const panel = mountPanel();
  await task(() => {
    shelf("open");
    startSlide();
    drag(120);
  });
  await task(() => settle(300));
  await task(endSlide);
  assert.deepEqual([openings, plays], [1, 1]);
  panel.remove();
});

it("dismisses the keyboard of a field on the page as a swipe toward the right panel starts", async () => {
  controller.abort();
  const own = new AbortController();
  const panel = mountPanel();
  mountPhoneDrawer(document, own.signal);
  const composer = document.createElement("textarea");
  inset.append(composer);
  composer.focus();
  await task(() => drag(-40));
  assert.notEqual(document.activeElement, composer);
  own.abort();
  panel.remove();
});

it("counts a right panel that is already open at mount as opened", async () => {
  controller.abort();
  const panel = mountPanel();
  panelState(panel, "full");
  const own = new AbortController();
  let count = 0;
  mountPhoneDrawer(document, own.signal, { opening: () => {}, opened: () => count++ });
  await task(() => drag(-300));
  await task(clearSlide);
  assert.equal(count, 0);
  own.abort();
  panel.remove();
});

it("treats a right panel mounted already open as opened when dragged closed and sprung back", async () => {
  const panel = mountPanel("full");
  await task(() => drag(-300));
  await task(() => settle(-390));
  await task(clearSlide);
  assert.deepEqual([openings, plays], [0, 0]);
  panel.remove();
});

it("runs again when the right panel is replaced while open", async () => {
  const first = mountPanel();
  await task(() => panelState(first, "full"));
  assert.equal(plays, 1);
  first.remove();
  const second = mountPanel();
  await task(() => panelState(second, "full"));
  assert.deepEqual([openings, plays], [2, 2]);
  second.remove();
});

it("plays for a swipe toward a right panel that mounted after the script", async () => {
  const panel = mountPanel();
  await task(() => drag(-80));
  await task(() => settle(-390));
  assert.deepEqual([openings, plays], [1, 1]);
  await task(() => {
    panelState(panel, "full");
    clearSlide();
  });
  assert.deepEqual([openings, plays], [1, 1]);
  panel.remove();
});

// The observers run only at compact width and watch the page and panel directly.
const fakeCompactQuery = (matches: boolean) => {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    listenerCount: () => listeners.size,
    set(next: boolean) {
      this.matches = next;
      for (const listener of listeners) listener();
    },
  };
};

it("stays idle at desktop width and starts tracking once the viewport turns compact", async () => {
  controller.abort();
  const query = fakeCompactQuery(false);
  const own = new AbortController();
  let opened = 0;
  mountPhoneDrawer(
    document,
    own.signal,
    { opening: () => {}, opened: () => opened++ },
    { compact: query as unknown as MediaQueryList },
  );
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.equal(opened, 0);
  await task(() => shelf("closed"));

  query.set(true);
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.equal(opened, 1);

  query.set(false);
  await task(() => shelf("closed"));
  await task(startSlide);
  await task(() => {
    shelf("open");
    endSlide();
  });
  assert.equal(opened, 1);

  own.abort();
  assert.equal(query.listenerCount(), 0);
});

it("observes inline style only on the page itself, never document-wide", () => {
  controller.abort();
  const calls: { target: Node; options: MutationObserverInit | undefined }[] = [];
  const original = MutationObserver.prototype.observe;
  MutationObserver.prototype.observe = function (target, options) {
    calls.push({ target, options });
    return original.call(this, target, options);
  };
  const panel = mountPanel();
  const own = new AbortController();
  try {
    mountPhoneDrawer(document, own.signal, { opening: () => {}, opened: () => {} });
  } finally {
    MutationObserver.prototype.observe = original;
  }
  for (const { target, options } of calls) {
    if (options?.subtree === true) {
      assert.equal(target, document.documentElement);
      assert.deepEqual(options.attributeFilter, ["data-sidebar-shelf", "data-state"]);
      assert.notEqual(options.childList, true);
    }
  }
  const styleWatch = calls.find(({ options }) => options?.attributeFilter?.includes("style"));
  assert.equal(styleWatch?.target, inset);
  assert.notEqual(styleWatch?.options?.subtree, true);
  const panelWatch = calls.find(
    ({ target, options }) => target === panel && options?.attributeFilter?.includes("data-state"),
  );
  assert.equal(panelWatch?.target, panel);
  assert.notEqual(panelWatch?.options?.subtree, true);
  own.abort();
  panel.remove();
});

it("ignores inline style changes on elements other than the page", async () => {
  const other = document.createElement("div");
  document.body.append(other);
  await task(() => {
    other.style.translate = "-200px";
    other.style.transition = "translate 220ms ease";
  });
  assert.deepEqual([openings, plays], [0, 0]);
  other.remove();
});

it("follows a page that replaces the observed one deep in the tree", async () => {
  const shell = document.createElement("div");
  document.body.append(shell);
  inset.remove();
  const late = document.createElement("main");
  late.setAttribute("data-sidebar", "inset");
  late.setAttribute("data-sidebar-shelf", "closed");
  shell.append(late);
  // A tapped open flips the new page's shelf, which is watched document-wide.
  await task(() => late.setAttribute("data-sidebar-shelf", "open"));
  assert.deepEqual([openings, plays], [1, 1]);
  await task(() => late.setAttribute("data-sidebar-shelf", "closed"));
  // From then on its own slide is observed.
  await task(() => late.setAttribute("data-vaul-animate", "false"));
  assert.equal(openings, 2);
  shell.remove();
});
