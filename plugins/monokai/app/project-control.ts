/** BB owns project selection. This adapter only invokes its native no-project option. */
export function mountProjectControl() {
  const triggerSelector = "[data-new-thread-footer] button[data-promptbox-project-control]";
  const optionSelector = '[cmdk-item][data-value="no-project"]';
  const controls = new Map<
    HTMLButtonElement,
    { anchor: HTMLElement; clear: HTMLButtonElement; icon: SVGElement; resize: ResizeObserver }
  >();
  const renamed = new Map<Text, string>();
  let pending: HTMLButtonElement | null = null;
  let openedForClear = false;
  let restorePicker: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;

  function cancelPending() {
    pending = null;
    openedForClear = false;
    clearTimeout(timeout);
  }

  function suppressPicker(dialog: Element) {
    restorePicker?.();
    const backdrop = dialog.previousElementSibling;
    const surfaces = backdrop?.matches("[data-persistent-drawer-backdrop]")
      ? [dialog, backdrop]
      : [dialog];
    for (const surface of surfaces) surface.setAttribute("data-monokai-project-clearing", "");
    const restore = () => {
      clearTimeout(exitTimeout);
      dialog.removeEventListener("animationend", onExit);
      dialog.removeEventListener("transitionend", onExit);
      for (const surface of surfaces) surface.removeAttribute("data-monokai-project-clearing");
      if (restorePicker === restore) restorePicker = undefined;
    };
    const onExit = (event: Event) => {
      if (event.target === dialog && dialog.getAttribute("data-state") === "closed") restore();
    };
    // Radix removes desktop content; compact drawers persist after a 220ms exit.
    // The bound also releases detached content or reduced-motion exits without an event.
    const exitTimeout = setTimeout(restore, 1000);
    dialog.addEventListener("animationend", onExit);
    dialog.addEventListener("transitionend", onExit);
    restorePicker = restore;
  }

  function onNativePickerClick(event: MouseEvent) {
    // A genuine label click may reopen a persistent drawer before its exit ends.
    if (event.isTrusted && event.target instanceof Element && event.target.closest(triggerSelector))
      restorePicker?.();
  }
  document.addEventListener("click", onNativePickerClick, true);

  function renameOptions() {
    for (const node of renamed.keys()) {
      if (!node.isConnected) renamed.delete(node);
    }
    // Replace the text node itself: both visual and accessible names change.
    for (const option of document.querySelectorAll(optionSelector)) {
      for (const node of option.childNodes) {
        if (node instanceof Text && node.textContent?.trim() === "Don't work in a project") {
          renamed.set(node, node.textContent);
          node.textContent = "No project";
        }
      }
    }
  }

  function selectPending() {
    if (pending) {
      const trigger = pending;
      const dialogId = trigger.getAttribute("aria-controls");
      // Compact BB uses a persistent drawer without aria-controls. Only the
      // open Project drawer is eligible while this exact trigger is open.
      const dialog = dialogId
        ? document.getElementById(dialogId)
        : trigger.getAttribute("aria-expanded") === "true"
          ? Array.from(document.querySelectorAll('[role="dialog"][data-state="open"]')).find(
              (element) =>
                document.getElementById(element.getAttribute("aria-labelledby") ?? "")
                  ?.textContent === "Project",
            )
          : null;
      const option = dialog?.querySelector<HTMLElement>(optionSelector);
      if (trigger.disabled || !trigger.isConnected) cancelPending();
      else if (option && option.getAttribute("aria-disabled") !== "true") {
        if (openedForClear && dialog) suppressPicker(dialog);
        cancelPending();
        option.click();
      }
    }
  }

  function reconcile() {
    frame = 0;
    renameOptions();
    selectPending();
    for (const [trigger, control] of controls) {
      if (
        !trigger.isConnected ||
        !trigger.querySelector('[data-icon="Folder"]') ||
        trigger.getAttribute("aria-busy") === "true"
      ) {
        if (document.activeElement === control.clear && trigger.isConnected) trigger.focus();
        control.resize.disconnect();
        control.anchor.remove();
        control.icon.removeAttribute("data-monokai-project-icon");
        controls.delete(trigger);
      } else {
        control.clear.disabled = trigger.disabled;
      }
    }
    for (const trigger of document.querySelectorAll<HTMLButtonElement>(triggerSelector)) {
      const icon = trigger.querySelector<SVGElement>('svg[data-icon="Folder"]');
      if (controls.has(trigger) || !icon || trigger.getAttribute("aria-busy") === "true") continue;
      const anchor = document.createElement("span");
      anchor.className = "monokai-project-anchor";
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "monokai-project-clear";
      clear.setAttribute("aria-label", "Clear selected project");
      clear.title = "Clear selected project";
      clear.disabled = trigger.disabled;
      clear.append(icon.cloneNode(true));
      const cross = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      cross.setAttribute("viewBox", "0 0 24 24");
      cross.setAttribute("fill", "none");
      cross.setAttribute("stroke", "currentColor");
      cross.setAttribute("stroke-width", "1.5");
      cross.setAttribute("aria-hidden", "true");
      cross.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>';
      clear.append(cross);
      anchor.append(clear);
      trigger.before(anchor);
      icon.setAttribute("data-monokai-project-icon", "");
      const position = () => {
        const target = icon.getBoundingClientRect();
        const origin = anchor.getBoundingClientRect();
        clear.style.left = `${target.x - origin.x - 6}px`;
        clear.style.top = `${target.y - origin.y - 6}px`;
        clear.style.width = `${target.width + 12}px`;
        clear.style.height = `${target.height + 12}px`;
      };
      const resize = new ResizeObserver(position);
      resize.observe(trigger);
      resize.observe(trigger.parentElement ?? trigger);
      // Keep BB's page-level Space shortcut from stealing button activation.
      for (const type of ["keydown", "keyup"]) {
        clear.addEventListener(type, (event) => {
          if (event instanceof KeyboardEvent && (event.key === " " || event.key === "Enter"))
            event.stopPropagation();
        });
      }
      clear.addEventListener("click", () => {
        if (trigger.disabled || trigger.getAttribute("aria-busy") === "true" || pending) return;
        pending = trigger;
        openedForClear = trigger.getAttribute("aria-expanded") !== "true";
        timeout = setTimeout(cancelPending, 1500);
        if (openedForClear) trigger.click();
        schedule();
      });
      controls.set(trigger, { anchor, clear, icon, resize });
      position();
    }
  }
  function schedule() {
    if (!frame) frame = requestAnimationFrame(reconcile);
  }
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) => {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.closest(".monokai-project-anchor")) return false;
        if (target?.closest(`${triggerSelector}, ${optionSelector}`)) return true;
        return (
          Array.from(record.addedNodes).some(
            (node) =>
              node instanceof Element &&
              (node.matches(`${triggerSelector}, ${optionSelector}`) ||
                node.querySelector(`${triggerSelector}, ${optionSelector}`)),
          ) ||
          Array.from(record.removedNodes).some(
            (node) =>
              node instanceof Element &&
              (node.matches(triggerSelector) || node.querySelector(triggerSelector)),
          )
        );
      })
    )
      schedule();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-busy", "aria-expanded", "data-icon"],
  });
  reconcile();
  return () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
    cancelPending();
    restorePicker?.();
    document.removeEventListener("click", onNativePickerClick, true);
    for (const [trigger, { anchor, icon, resize }] of controls) {
      if (document.activeElement === anchor.firstElementChild && trigger.isConnected)
        trigger.focus();
      resize.disconnect();
      anchor.remove();
      icon.removeAttribute("data-monokai-project-icon");
    }
    for (const [node, original] of renamed) {
      if (node.isConnected && node.textContent === "No project") node.textContent = original;
    }
  };
}
