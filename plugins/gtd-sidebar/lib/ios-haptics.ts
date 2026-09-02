/**
 * Vendored from ios-haptics v3.1.1 — https://github.com/tijnjh/ios-haptics
 * MIT License, Copyright (c) 2025 tijn. See THIRD_PARTY_NOTICES.md.
 *
 * iOS Safari plays a haptic when the user taps a native `<input switch>`.
 * Since iOS 26.5 only a DIRECT tap on the switch fires it — `.click()` from
 * script no longer does — so the library lays an invisible switch over the
 * element and lets the user's own tap land on it. That is also why no haptic
 * can fire at the long-press moment: nothing was tapped yet.
 *
 * Known upstream caveat (tijnjh/ios-haptics#11): the overlay swallows a scroll
 * that starts on the element. Only attach it to elements that never scroll,
 * such as menu items.
 */

export function isIos() {
  if (typeof navigator === "undefined") return false;

  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function hapticTrigger(element: HTMLElement | undefined | null) {
  if (!element || typeof window === "undefined") {
    return;
  }

  if (!isIos()) {
    return;
  }

  const switchEl = document.createElement("input");

  switchEl.type = "checkbox";
  switchEl.setAttribute("switch", "");
  switchEl.setAttribute("data-haptic-trigger", "");
  switchEl.setAttribute("aria-hidden", "true");
  switchEl.tabIndex = -1;

  const styles: Partial<CSSStyleDeclaration> = {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    margin: "0",
    opacity: "0",
    clipPath: "inset(0 round 999px)",
    touchAction: "manipulation",
  };

  Object.assign(switchEl.style, styles);

  switchEl.style.setProperty("-webkit-tap-highlight-color", "transparent");

  if (getComputedStyle(element).position === "static") {
    element.style.position = "relative";
  }

  element.insertAdjacentElement("beforeend", switchEl);
}

/**
 * Idempotent wrapper for React ref callbacks, which may run more than once
 * for the same node. The vendored `hapticTrigger` stays verbatim above.
 */
export function attachHapticTrigger(element: HTMLElement | null) {
  if (!element || element.querySelector("[data-haptic-trigger]")) return;
  hapticTrigger(element);
}
