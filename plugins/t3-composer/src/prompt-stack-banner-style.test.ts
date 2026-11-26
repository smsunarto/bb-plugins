// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  CARD_ATTR,
  FLAT_ROW_ATTR,
  LABEL_ATTR,
  mountPromptStackBannerStyle,
  PROMPT_STACK_BANNER_CSS,
  syncPromptStackCards,
  TOGGLE_ATTR,
  VALUE_ATTR,
} from "./prompt-stack-banner-style";

const styles = () => document.head.querySelectorAll("style[data-t3-prompt-stack-banner-style]");

function flushMutations(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

afterEach(() => {
  document.body.innerHTML = "";
  for (const style of styles()) style.remove();
});

describe("mountPromptStackBannerStyle", () => {
  it("adds one marked stylesheet and removes stylesheet and all marks on dispose", () => {
    document.body.innerHTML = `
      <div data-promptbox-shell="">
        <div>
          <section aria-label="Child threads">
            <button aria-expanded="false">
              <svg class="animate-shine-icon"></svg>
              <span class="font-normal">Active child threads</span>
              <span><span>1</span></span>
            </button>
          </section>
        </div>
      </div>
    `;
    const card = document.querySelector('section[aria-label="Child threads"]')!;
    const btn = card.querySelector("button")!;
    const label = btn.querySelector("span.font-normal")!;
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    expect(styles()).toHaveLength(1);
    expect(styles()[0]?.textContent).toBe(PROMPT_STACK_BANNER_CSS);
    expect(card.hasAttribute(CARD_ATTR)).toBe(true);
    expect(btn.hasAttribute(TOGGLE_ATTR)).toBe(true);
    expect(label.hasAttribute(LABEL_ATTR)).toBe(true);
    dispose();
    expect(styles()).toHaveLength(0);
    expect(card.hasAttribute(CARD_ATTR)).toBe(false);
    expect(btn.hasAttribute(TOGGLE_ATTR)).toBe(false);
    expect(label.hasAttribute(LABEL_ATTR)).toBe(false);
  });

  it("removes the stylesheet and marks when the signal aborts", () => {
    document.body.innerHTML = `
      <div data-promptbox-shell=""><div><section aria-label="To-do list"></section></div></div>
    `;
    const controller = new AbortController();
    const dispose = mountPromptStackBannerStyle(document, controller.signal);
    expect(styles()).toHaveLength(1);
    expect(document.querySelectorAll(`[${CARD_ATTR}]`)).toHaveLength(1);
    controller.abort();
    expect(styles()).toHaveLength(0);
    expect(document.querySelectorAll(`[${CARD_ATTR}]`)).toHaveLength(0);
    dispose();
    expect(styles()).toHaveLength(0);
  });

  it("adds nothing when already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    mountPromptStackBannerStyle(document, controller.signal)();
    expect(styles()).toHaveLength(0);
  });

  it("tags top-level cards and header toggles while excluding body buttons, nested inline forms, and nested composers", async () => {
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    const shell = document.createElement("div");
    shell.setAttribute("data-promptbox-shell", "");
    shell.innerHTML = `
      <div class="grid gap-2">
        <div data-bb-plugin-root="" data-bb-plugin="captain">
          <section aria-label="captain">
            <span hidden data-captain-overview-anchor=""></span>
            <div data-bb-plugin="captain" role="toolbar">
              <div id="ask-panel">
                <div>
                  <div data-detail-box="">Long detail</div>
                  <button id="captain-more" type="button" aria-expanded="false">More</button>
                </div>
                <div data-captain-answer-row="">
                  <button id="captain-read-plan" type="button" aria-expanded="false">Read plan</button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <section aria-label="Plan">
          <div role="group" aria-label="Plan controls" class="bg-background/70">
            <button id="plan-toggle" type="button" aria-expanded="false" aria-controls="plan-body">
              <svg class="animate-shine-icon"></svg>
              <span class="animate-shine">Plan</span>
            </button>
            <button id="plan-dismiss" type="button" aria-label="Dismiss plan">X</button>
          </div>
          <section id="plan-body" role="region" aria-hidden="true">
            <button id="plan-collapse" type="button" aria-expanded="true">Collapse</button>
          </section>
        </section>

        <section aria-label="To-do list">
          <div class="flex items-center">
            <button id="todo-toggle" type="button" aria-expanded="false" aria-controls="todo-body">
              <svg class="animate-shine-icon"></svg>
              <span class="animate-shine">1/3 complete</span>
            </button>
          </div>
          <section id="todo-body" role="region" aria-hidden="true"></section>
        </section>

        <section aria-label="Thread context before sending">
          <div>
            <div data-bb-plugin="source-control" class="contents">
              <span data-testid="sc-strip">Local branch</span>
            </div>
            <div data-bb-plugin="bb--git" class="contents">
              <button id="git-toggle" type="button" aria-expanded="false" aria-controls="git-body">
                <svg></svg>
                <span data-promptbox-hide-compact="">Untracked · <span>+5</span> <span>-2</span></span>
              </button>
            </div>
          </div>
          <div data-bb-plugin="bb--git" class="contents">
            <section id="git-body" role="region" aria-hidden="true"></section>
          </div>
        </section>

        <section aria-label="Child threads">
          <button id="child-back-btn" type="button" aria-label="Back to active child threads">
            <svg></svg>
            <svg class="animate-shine-icon"></svg>
            <span class="font-normal">Active child threads</span>
          </button>
          <section id="child-body" role="region" aria-hidden="false">
            <section aria-label="Confirm tool call" data-presentation="inline"></section>
            <button id="child-collapse" type="button" aria-expanded="true">Collapse</button>
          </section>
        </section>

        <section aria-label="Workflow">
          <button id="workflow-toggle" type="button" aria-expanded="true" aria-controls="workflow-body">
            <svg class="animate-shine-icon"></svg>
            <span><span>Deploy</span><span>1/2 agents</span></span>
          </button>
          <section id="workflow-body" role="region" aria-hidden="false">
            <button id="workflow-phase-toggle" type="button" aria-expanded="false">Phase 1</button>
          </section>
        </section>

        <section aria-label="Queued messages">
          <header data-queued-messages-mode="expanded">
            <button id="queue-toggle" type="button" aria-expanded="true" aria-controls="queue-list">
              <span class="font-normal">Queue</span>
            </button>
          </header>
          <div id="queue-list" data-queued-messages-scroll-frame="">
            <button id="queue-overflow" type="button" aria-expanded="false">More</button>
            <div data-promptbox-shell="">
              <div>
                <div data-bb-plugin-root="" data-bb-plugin="kitchen-sink">
                  <section aria-label="kitchen-sink" class="empty:hidden"></section>
                </div>
              </div>
            </div>
          </div>
        </section>

        <div data-bb-plugin-root="" data-bb-plugin="source-control">
          <section aria-label="source-control">
            <div data-bb-plugin="source-control" data-testid="sc-pr-watch">
              <div data-state="closed">
                <div>
                  <button id="pr-watch-toggle-1" type="button" aria-expanded="false" aria-controls="pr-1">Checks passed</button>
                  <button id="pr-watch-unwatch" type="button">Unwatch</button>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div data-bb-plugin-root="" data-bb-plugin="kitchen-sink">
          <section aria-label="kitchen-sink">
            <div class="rpiv-todo-card">
              <div>
                <button id="rpiv-toggle" type="button" aria-expanded="false" aria-controls="rpiv-body">1/3 complete</button>
              </div>
              <section id="rpiv-body" aria-hidden="true"></section>
            </div>
          </section>
        </div>

        <section aria-label="Confirm tool call" data-expanded="">
          <div>
            <button id="pending-label-btn" type="button" aria-expanded="true" aria-controls="pending-content">Approve</button>
            <button id="pending-chevron-btn" type="button" aria-expanded="true" aria-controls="pending-content">Hide</button>
          </div>
        </section>

        <div class="relative">
          <div data-prompt-stack-peek=""></div>
          <div class="relative">
            <section aria-label="Workflows"></section>
          </div>
        </div>
      </div>
    `;
    document.body.append(shell);
    await flushMutations();

    // Top-level header toggles are tagged; nested body & toolbar buttons are not.
    const taggedToggleIds = [...document.querySelectorAll(`[${TOGGLE_ATTR}]`)].map((el) => el.id);
    expect(taggedToggleIds).toEqual([
      "plan-toggle",
      "todo-toggle",
      "git-toggle",
      "child-back-btn",
      "workflow-toggle",
      "queue-toggle",
      "pr-watch-toggle-1",
      "rpiv-toggle",
    ]);

    for (const excludedId of [
      "captain-more",
      "captain-read-plan",
      "plan-dismiss",
      "plan-collapse",
      "child-collapse",
      "workflow-phase-toggle",
      "queue-overflow",
      "pr-watch-unwatch",
      "pending-label-btn",
      "pending-chevron-btn",
    ]) {
      expect(document.getElementById(excludedId)?.hasAttribute(TOGGLE_ATTR), excludedId).toBe(
        false,
      );
    }

    // Plan's div[role="group"] is flattened; Plan, To-do, Active child threads & Queue labels
    // are marked (clearing .animate-shine sweeps); bb--git's +5/-2 diff spans are NOT touched.
    expect(document.querySelector('div[role="group"]')?.hasAttribute(FLAT_ROW_ATTR)).toBe(true);
    expect([...document.querySelectorAll(`[${LABEL_ATTR}]`)].map((el) => el.textContent)).toEqual([
      "Plan",
      "1/3 complete",
      "Active child threads",
      "Queue",
    ]);
    expect(document.querySelectorAll(`[${VALUE_ATTR}]`)).toHaveLength(0);

    // Inline PendingInteractionShell, disclosure bodies, and nested composer cards are never tagged.
    expect(
      document.querySelector('section[data-presentation="inline"]')?.hasAttribute(CARD_ATTR),
    ).toBe(false);
    expect(document.querySelector("#git-body")?.hasAttribute(CARD_ATTR)).toBe(false);
    expect(document.querySelector("#child-body")?.hasAttribute(CARD_ATTR)).toBe(false);
    expect(
      document
        .querySelector('[data-queued-messages-scroll-frame] section[aria-label="kitchen-sink"]')
        ?.hasAttribute(CARD_ATTR),
    ).toBe(false);

    dispose();
  });

  it("tags a top-level promptbox inside a semantic <section> ancestor (e.g. ShowcaseHeroCarousel)", () => {
    document.body.innerHTML = `
      <section aria-roledescription="carousel">
        <div data-promptbox-shell="">
          <div>
            <section aria-label="Claude Code not installed"></section>
          </div>
        </div>
      </section>
    `;
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    const card = document.querySelector('section[aria-label="Claude Code not installed"]')!;
    expect(card.hasAttribute(CARD_ATTR)).toBe(true);
    dispose();
    expect(card.hasAttribute(CARD_ATTR)).toBe(false);
  });

  it("watches a late-added or replaced stack <div> inside a connected shell and cleans up when the shell is removed", async () => {
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    const shell = document.createElement("div");
    shell.setAttribute("data-promptbox-shell", "");
    document.body.append(shell);
    await flushMutations();

    // Late-added stack div inside the connected shell.
    const stack1 = document.createElement("div");
    stack1.innerHTML = `<section aria-label="Model fallback"></section>`;
    shell.append(stack1);
    await flushMutations();
    const card1 = stack1.querySelector("section")!;
    expect(card1.hasAttribute(CARD_ATTR)).toBe(true);

    // Replacing firstElementChild clears marks on old stack and tags the new stack.
    const stack2 = document.createElement("div");
    stack2.innerHTML = `<section aria-label="Machine status"></section>`;
    shell.replaceChild(stack2, stack1);
    await flushMutations();
    expect(card1.hasAttribute(CARD_ATTR)).toBe(false);
    const card2 = stack2.querySelector("section")!;
    expect(card2.hasAttribute(CARD_ATTR)).toBe(true);

    // Removing the shell unwatches it and clears marks.
    shell.remove();
    await flushMutations();
    expect(card2.hasAttribute(CARD_ATTR)).toBe(false);

    dispose();
  });

  it("tags 1-item and 2-item Background agents cards, updates cleanly on 1↔2 re-render, and cleans on dispose", async () => {
    document.body.innerHTML = `
      <div data-promptbox-shell="">
        <div>
          <section aria-label="Background agents">
            <div class="bg-background/70">
              <div aria-label="Background agent: Ship BBP-139 PR · Model sonnet">
                <svg class="animate-shine-icon"></svg>
                <span>
                  <span class="text-muted-foreground">Running background agent:</span>
                  <span class="animate-shine font-medium text-foreground">Ship BBP-139 PR</span>
                  <span class="font-mono text-2xs">sonnet</span>
                </span>
                <span>25s</span>
              </div>
            </div>
          </section>
        </div>
      </div>
    `;
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    const card = document.querySelector('section[aria-label="Background agents"]')!;
    expect(card.hasAttribute(CARD_ATTR)).toBe(true);
    expect(card.querySelectorAll(`[${FLAT_ROW_ATTR}]`)).toHaveLength(2);
    expect(card.querySelectorAll(`[${TOGGLE_ATTR}]`)).toHaveLength(0);
    expect([...card.querySelectorAll(`[${LABEL_ATTR}]`)].map((el) => el.textContent)).toEqual([
      "Running background agent:",
    ]);
    expect([...card.querySelectorAll(`[${VALUE_ATTR}]`)].map((el) => el.textContent)).toEqual([
      "Ship BBP-139 PR",
      "sonnet",
    ]);

    // Re-render into 2-item interactive state.
    card.innerHTML = `
      <div class="bg-background/70">
        <button type="button" aria-expanded="false" aria-controls="bg-body">
          <svg class="animate-shine-icon"></svg>
          <span>
            <span class="font-medium">Running 2 background agents</span>
            <span>·</span>
            <span class="animate-shine font-medium">Ship BBP-139 PR</span>
          </span>
        </button>
      </div>
    `;
    await flushMutations();

    expect(card.querySelectorAll(`[${FLAT_ROW_ATTR}]`)).toHaveLength(1);
    expect(card.querySelectorAll(`[${TOGGLE_ATTR}]`)).toHaveLength(1);
    expect([...card.querySelectorAll(`[${LABEL_ATTR}]`)].map((el) => el.textContent)).toEqual([
      "Running 2 background agents",
    ]);
    expect([...card.querySelectorAll(`[${VALUE_ATTR}]`)].map((el) => el.textContent)).toEqual([
      "·",
      "Ship BBP-139 PR",
    ]);

    dispose();
    expect(document.querySelectorAll(`[${FLAT_ROW_ATTR}]`)).toHaveLength(0);
    expect(document.querySelectorAll(`[${TOGGLE_ATTR}]`)).toHaveLength(0);
    expect(document.querySelectorAll(`[${LABEL_ATTR}]`)).toHaveLength(0);
    expect(document.querySelectorAll(`[${VALUE_ATTR}]`)).toHaveLength(0);
  });

  it("clears stale card marks when syncPromptStackCards runs after DOM moves", () => {
    const stack = document.createElement("div");
    const outer = document.createElement("section");
    const inner = document.createElement("section");
    inner.setAttribute(CARD_ATTR, "");
    outer.append(inner);
    stack.append(outer);

    syncPromptStackCards(stack);
    expect(outer.hasAttribute(CARD_ATTR)).toBe(true);
    expect(inner.hasAttribute(CARD_ATTR)).toBe(false);
  });
});
