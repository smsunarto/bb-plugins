// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  mountPromptStackBannerStyle,
  PROMPT_STACK_BANNER_CSS,
  PROMPT_STACK_CARD_SELECTOR,
} from "./prompt-stack-banner-style";

const styles = () => document.head.querySelectorAll("style[data-t3-prompt-stack-banner-style]");

describe("mountPromptStackBannerStyle", () => {
  it("adds one marked stylesheet and removes it on dispose", () => {
    const dispose = mountPromptStackBannerStyle(document, new AbortController().signal);
    expect(styles()).toHaveLength(1);
    expect(styles()[0]?.textContent).toBe(PROMPT_STACK_BANNER_CSS);
    dispose();
    expect(styles()).toHaveLength(0);
  });

  it("removes the stylesheet when the signal aborts", () => {
    const controller = new AbortController();
    const dispose = mountPromptStackBannerStyle(document, controller.signal);
    expect(styles()).toHaveLength(1);
    controller.abort();
    expect(styles()).toHaveLength(0);
    dispose();
    expect(styles()).toHaveLength(0);
  });

  it("adds nothing when already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    mountPromptStackBannerStyle(document, controller.signal)();
    expect(styles()).toHaveLength(0);
  });

  it("targets all prompt-stack cards through one shared semantic selector", () => {
    expect(PROMPT_STACK_CARD_SELECTOR).toContain("[data-promptbox-shell]");
    expect(PROMPT_STACK_BANNER_CSS).not.toMatch(
      /\.rounded-lg|\.border-border|\.ring-1|\.bg-background|thread-prompt-banner-|aria-label="/,
    );
    expect(PROMPT_STACK_BANNER_CSS).toContain("::after");
    expect(PROMPT_STACK_BANNER_CSS).toContain('section[aria-hidden="false"]::before');
  });
});
