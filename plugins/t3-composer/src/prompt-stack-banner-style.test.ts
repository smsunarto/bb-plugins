// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  CARD_ATTR,
  mountPromptStackBannerStyle,
  PROMPT_STACK_BANNER_CSS,
  syncPromptStackCards,
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
  it("adds one marked stylesheet and removes stylesheet and card marks on dispose", () => {
    document.body.innerHTML = `
      <div data-promptbox-shell="">
        <div>
          <section aria-label="captain">All clear</section>
        </div>
      </div>
    `;
    const card = document.querySelector('section[aria-label="captain"]')!;
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    expect(styles()).toHaveLength(1);
    expect(styles()[0]?.textContent).toBe(PROMPT_STACK_BANNER_CSS);
    expect(card.hasAttribute(CARD_ATTR)).toBe(true);
    dispose();
    expect(styles()).toHaveLength(0);
    expect(card.hasAttribute(CARD_ATTR)).toBe(false);
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

  it("tags top-level cards across wrappers without tagging nested inline forms, disclosure bodies, or queued-message editors", async () => {
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    const shell = document.createElement("div");
    shell.setAttribute("data-promptbox-shell", "");
    shell.innerHTML = `
      <div class="grid gap-2">
        <div data-bb-plugin-root="" data-bb-plugin="captain">
          <section aria-label="captain">All clear</section>
        </div>
        <section aria-label="Thread context before sending">
          <div>Local branch</div>
          <div data-bb-plugin="bb--git" class="contents">
            <section id="thread-prompt-banner-git-body" role="region" aria-hidden="true"></section>
          </div>
        </section>
        <section aria-label="Child threads">
          <button id="thread-prompt-banner-child-threads-toggle" aria-expanded="true"></button>
          <section id="thread-prompt-banner-child-threads-body" role="region" aria-hidden="false">
            <section aria-label="Confirm tool call" data-presentation="inline"></section>
          </section>
        </section>
        <section aria-label="Queued messages">
          <div data-promptbox-shell="">
            <div>
              <div data-bb-plugin-root="" data-bb-plugin="kitchen-sink">
                <section aria-label="kitchen-sink" class="empty:hidden"></section>
              </div>
            </div>
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

    const marked = [...document.querySelectorAll(`[${CARD_ATTR}]`)].map((el) =>
      el.getAttribute("aria-label"),
    );
    expect(marked).toEqual([
      "captain",
      "Thread context before sending",
      "Child threads",
      "Queued messages",
      "Workflows",
    ]);

    // Inline PendingInteractionShell and disclosure regions are never tagged as cards.
    expect(
      document.querySelector('section[data-presentation="inline"]')?.hasAttribute(CARD_ATTR),
    ).toBe(false);
    expect(document.querySelector("#thread-prompt-banner-git-body")?.hasAttribute(CARD_ATTR)).toBe(
      false,
    );
    expect(
      document.querySelector("#thread-prompt-banner-child-threads-body")?.hasAttribute(CARD_ATTR),
    ).toBe(false);
    expect(
      document.querySelector('section[aria-label="kitchen-sink"]')?.hasAttribute(CARD_ATTR),
    ).toBe(false);

    // Late-mounted banner card inside the stack gets tagged automatically.
    const late = document.createElement("section");
    late.setAttribute("aria-label", "Model fallback");
    shell.firstElementChild!.append(late);
    await flushMutations();
    expect(late.hasAttribute(CARD_ATTR)).toBe(true);

    dispose();
  });

  it("uses narrow attribute-anchored CSS without :has(), bare-span rules, utility classes, or icon glimmer", () => {
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/:has\(/);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/\bspan\b/);
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(
      /\.rounded-lg|\.border-border|\.ring-1|\.bg-background/,
    );
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(/div\[role="group"\]|div\[aria-label\]/);
    expect(PROMPT_STACK_BANNER_CSS).toContain(`[${CARD_ATTR}]::after`);
    expect(PROMPT_STACK_BANNER_CSS).toContain(`[${CARD_ATTR}] .animate-shine-icon`);
    expect(PROMPT_STACK_BANNER_CSS).toContain("mask-image: none !important");
    expect(PROMPT_STACK_BANNER_CSS).toContain("animation: none !important");
    expect(PROMPT_STACK_BANNER_CSS).toContain(
      `[${CARD_ATTR}] section[aria-hidden="false"]::before`,
    );
    expect(PROMPT_STACK_BANNER_CSS).toContain(`[${CARD_ATTR}] section[aria-hidden="true"]`);
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
