// An agent option such as Codex's Daybreak has no SDK setter: `setSelection` takes only the
// provider, model, effort, speed and permission. So the effort panel reaches it through BB's
// own picker, which the composer hands over as `executionControls`. The panel mounts that
// picker out of sight, opens it unseen, reads or presses the option's switch, and closes it.
//
// Private contracts, to recheck after BB upgrades: the picker's trigger is the only
// `button[aria-haspopup="dialog"]` in what `executionControls` renders; on desktop its
// popover names itself through the trigger's `aria-controls` once open, and on a phone it is
// the `[data-persistent-drawer-content]` that opens when the trigger is pressed; and it shows
// each on/off agent option as a `[role="switch"]` whose `aria-label` is the option's label.
//
// BB's popover is modal, so while it is open the page ignores pointers outside it; app.css
// lets them through to the effort panel, and a click there closes BB's popover, which ends
// the drive. Drives are short and rare: one read per composer and model, and one per press.

/** Set on <html> while a drive runs; app.css hides BB's popover under it. */
export const DRIVING_ATTRIBUTE = "data-t3-driving-bb-picker";
const DEADLINE_MS = 2500;
/** A freshly mounted picker lists agent options only once it has loaded the model's. */
const LOAD_DEADLINE_MS = 10_000;
/** Once the picker shows its options, how long the switch may take to join them. */
const SETTLE_MS = 1500;

/** BB's picker does not offer the option here: no trigger, or no such switch once loaded. */
export class BbSwitchMissing extends Error {}

let queue: Promise<unknown> = Promise.resolve();

/** Whether the option's switch is on in BB's picker. */
export function readBbSwitch(host: HTMLElement, label: string, signal: AbortSignal) {
  return drive(host, signal, async (popover, ended) =>
    isOn(await findSwitch(popover, label, ended)),
  );
}

/** Flips the option's switch in BB's picker, resolving with the value BB then shows. */
export function toggleBbSwitch(host: HTMLElement, label: string, signal: AbortSignal) {
  return drive(host, signal, async (popover, ended) => {
    const control = await findSwitch(popover, label, ended);
    const next = !isOn(control);
    control.click();
    await until(() => (isOn(control) === next ? true : null), ended, "BB did not apply it");
    return next;
  });
}

/** Drives run one at a time, so two never fight over the one popover. */
function drive<T>(
  host: HTMLElement,
  signal: AbortSignal,
  act: (popover: HTMLElement, ended: AbortSignal) => Promise<T>,
): Promise<T> {
  const run = queue.then(() => driveOnce(host, signal, act));
  queue = run.catch(() => undefined);
  return run;
}

async function driveOnce<T>(
  host: HTMLElement,
  signal: AbortSignal,
  act: (popover: HTMLElement, ended: AbortSignal) => Promise<T>,
) {
  signal.throwIfAborted();
  const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  // BB renders no popover while the agent waits on a question or the thread is read-only.
  if (!trigger || trigger.disabled) throw new BbSwitchMissing("BB's agent options are hidden.");
  const root = document.documentElement;
  root.setAttribute(DRIVING_ATTRIBUTE, "");
  // The host is inert between drives so nothing reaches the hidden picker; BB closes its
  // popover when the anchor turns inert, so it stays interactive until the popover closes.
  host.inert = false;
  // A drive ends when BB's popover closes, as a click on the panel or Escape makes it.
  const close = closeWatch(trigger);
  const ended = AbortSignal.any([signal, close.signal]);
  const focused = document.activeElement;
  let popover: HTMLElement | null = null;
  try {
    const openBefore = new Set(document.querySelectorAll(OPEN_DRAWER));
    trigger.click();
    popover = await until(() => popoverOf(trigger, openBefore), ended, "BB's picker did not open");
    return await act(popover, ended);
  } finally {
    close.stop();
    if (trigger.getAttribute("aria-expanded") === "true") trigger.click();
    host.inert = true;
    await nextFrame();
    // BB returns focus to its hidden trigger when it closes; give focus back to the panel
    // only then, so focus the user has since moved stays where they put it.
    const active = document.activeElement;
    if (!active || active === document.body || host.contains(active) || popover?.contains(active)) {
      const panel = document.querySelector<HTMLElement>("[data-t3-composer-menu]");
      const back =
        focused instanceof HTMLElement && focused.isConnected && panel?.contains(focused)
          ? focused
          : (panel?.querySelector<HTMLElement>('[role="slider"]') ?? panel);
      back?.focus({ preventScroll: true });
    }
    if (popover) await closed(popover);
    root.removeAttribute(DRIVING_ATTRIBUTE);
  }
}

/** Aborts once the trigger reports its popover closed after having opened it. */
function closeWatch(trigger: HTMLElement) {
  const controller = new AbortController();
  let opened = false;
  const observer = new MutationObserver(() => {
    const expanded = trigger.getAttribute("aria-expanded") === "true";
    if (expanded) opened = true;
    else if (opened) {
      observer.disconnect();
      controller.abort(new DOMException("BB's picker closed.", "AbortError"));
    }
  });
  observer.observe(trigger, { attributes: true, attributeFilter: ["aria-expanded"] });
  // The drive's own close needs no report: `stop` runs before it.
  return { signal: controller.signal, stop: () => observer.disconnect() };
}

const OPEN_DRAWER = '[data-persistent-drawer-content][data-state="open"]';

/** The popover by id; on a phone, the drawer that opened after the trigger was pressed. */
function popoverOf(trigger: HTMLElement, openBefore: ReadonlySet<Element>) {
  const id = trigger.getAttribute("aria-controls");
  if (id) return document.getElementById(id);
  return (
    [...document.querySelectorAll<HTMLElement>(OPEN_DRAWER)].find(
      (drawer) => !openBefore.has(drawer),
    ) ?? null
  );
}

/** Keeps the popover hidden through its exit, until it leaves the page or, as a phone's
 * drawer stays mounted, until it has slid away. */
async function closed(popover: HTMLElement) {
  const drawer = popover.hasAttribute("data-persistent-drawer-content");
  await until(
    () => (!popover.isConnected || (drawer && popover.dataset.state === "closed") ? true : null),
    AbortSignal.timeout(DEADLINE_MS),
    "",
  ).catch(() => undefined);
  if (!popover.isConnected) return;
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    popover.addEventListener("transitionend", done, { once: true });
    window.setTimeout(done, 400);
  });
}

/**
 * The option's switch. The picker may still be loading; once it shows any option or model
 * row, the switch has `SETTLE_MS` to appear before the option counts as missing here.
 */
function findSwitch(popover: HTMLElement, label: string, signal: AbortSignal) {
  let loadedAt: number | null = null;
  return until(
    () => {
      const control = [...popover.querySelectorAll<HTMLElement>('[role="switch"]')].find(
        (candidate) => candidate.getAttribute("aria-label") === label,
      );
      if (control) return control;
      if (loadedAt === null && popover.querySelector('[role="switch"], [role="option"]')) {
        loadedAt = performance.now();
      }
      if (loadedAt !== null && performance.now() - loadedAt > SETTLE_MS) {
        throw new BbSwitchMissing(`BB's picker shows no ${label} switch here.`);
      }
      return null;
    },
    signal,
    `BB's picker did not load its ${label} switch`,
    LOAD_DEADLINE_MS,
  );
}

function isOn(control: HTMLElement) {
  return control.getAttribute("aria-checked") === "true";
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

/** Polls each frame until `find` returns a value, rejecting on abort or at the deadline. */
async function until<T>(
  find: () => T | null,
  signal: AbortSignal,
  failure: string,
  timeout = DEADLINE_MS,
): Promise<T> {
  const deadline = performance.now() + timeout;
  for (;;) {
    signal.throwIfAborted();
    const found = find();
    if (found !== null) return found;
    if (performance.now() > deadline) throw new Error(`${failure}.`);
    await nextFrame();
  }
}
