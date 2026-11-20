// Keep bb's floating sidebar toggle out of the phone navigation header.
const NAVIGATION = '[data-sidebar="panel"][data-vaul-drawer-direction]:has([data-gtd-phone-nav])';
const OPEN_DRAWER = '[data-sidebar="inset"][data-sidebar-shelf="open"]';
const TOGGLE = `${NAVIGATION} ~ ${OPEN_DRAWER} ~ [data-testid="app-sidebar-trigger-overlay"]`;

const RULES = `
  ${TOGGLE} {
    left: min(calc(var(--sidebar-width-mobile) + 4px), calc(100vw - 48px));
    padding-inline: 0;
  }
  ${TOGGLE} > [data-sidebar="trigger"] {
    min-width: 44px;
    min-height: 44px;
  }
`;

export function mountPhoneDrawerStyle(document: Document, signal: AbortSignal): () => void {
  if (signal.aborted) return () => {};
  const style = document.createElement("style");
  style.setAttribute("data-gtd-phone-drawer-style", "");
  style.textContent = RULES;
  document.head.append(style);
  const dispose = () => style.remove();
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
