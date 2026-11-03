// GTD's fold motion, kept from the sidebar before it moved onto bb's Thread
// list: a shelf, folder, or thread family slides its height, fades, and
// sharpens out of a 2px blur over 350ms on Animate UI's soft ease.
import { Component, createRef, type ReactNode } from "react";

/** Animate UI's `transition.disclosure`, as CSS timing. */
export const DISCLOSURE_TIMING = {
  duration: 350,
  easing: "cubic-bezier(0.215, 0.61, 0.355, 1)",
} as const;
const DISCLOSURE_BLUR = "blur(2px)";
/**
 * The rows fade over the panel's last 16px while it clips them. An opening
 * slide pushes that fade out below the panel as it lands, and a closing one
 * draws it in, so no row turns opaque or faded in a single frame.
 */
const DISCLOSURE_EDGE_MASK = "linear-gradient(to bottom, #000 calc(100% - 16px), transparent)";
const EDGE_FADE_IN = "100% 100%";
const EDGE_FADE_OUT = "100% calc(100% + 16px)";
/**
 * The panel holds its rows' margins, so its height is the same with the rows,
 * with their exit copy, and at rest; a margin collapsing through its edge
 * would land the slide a few pixels off and snap when it ends.
 */
const OPEN_STYLE = { display: "flow-root" } as const;
const CLOSED_STYLE = { display: "flow-root", height: 0 } as const;
/**
 * The attributes that name a row rather than style it: the selection,
 * shortcut, and focus code find rows by them across the document, so the
 * exit copy drops them and keeps the ones bb's and GTD's CSS draw with.
 */
const IDENTITY_ATTRIBUTES = new Set([
  "id",
  "data-index",
  "data-sidebar-windowed-item",
  "data-sidebar-windowed-nav",
  "data-sidebar-nest-drop-preview",
  "data-sidebar-drop-target",
]);
function isIdentityAttribute(name: string): boolean {
  return IDENTITY_ATTRIBUTES.has(name) || (name.startsWith("data-") && name.endsWith("-id"));
}

interface SlidingDisclosureProps {
  open: boolean;
  children?: ReactNode;
}

interface DisclosureSnapshot {
  height: number;
  opacity: string;
  content: HTMLDivElement | null;
}

/**
 * Folding rows leave React at once, so the windowed list and the drag
 * context never hold rows the fold removed; an inert copy with no ids, row
 * identities, or listeners plays their exit, styled as the rows were. Only a change of `open`
 * animates: rows the windowed list mounts while scrolling appear in place.
 */
export class SlidingDisclosure extends Component<
  SlidingDisclosureProps,
  unknown,
  DisclosureSnapshot | null
> {
  private panel = createRef<HTMLDivElement>();
  private animation: Animation | null = null;
  private pendingFrame = 0;
  private reducedMotion: MediaQueryList | null = null;

  override componentDidMount() {
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    this.reducedMotion?.addEventListener("change", this.finish);
  }

  override getSnapshotBeforeUpdate(previous: SlidingDisclosureProps): DisclosureSnapshot | null {
    const panel = this.panel.current;
    if (!panel || previous.open === this.props.open) return null;
    const height = panel.getBoundingClientRect().height;
    const opacity = previous.open || this.animation ? getComputedStyle(panel).opacity : "0";
    const content = this.props.open ? null : panel.cloneNode(true);
    this.cancelPendingFrame();
    this.animation?.cancel();
    this.animation = null;
    // An exit still playing leaves its copy in the panel; clear it before
    // React mounts the reopened rows.
    if (!previous.open) panel.replaceChildren();
    if (!(content instanceof HTMLDivElement)) return { height, opacity, content: null };
    content.style.height = "auto";
    content.style.overflow = "visible";
    content.style.maskImage = "none";
    content.inert = true;
    for (const element of content.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames()) {
        if (isIdentityAttribute(attribute)) element.removeAttribute(attribute);
      }
    }
    // Focus inside the folding rows returns to the toggle that folded them.
    if (panel.contains(document.activeElement)) {
      panel.previousElementSibling
        ?.querySelector<HTMLButtonElement>("button[aria-expanded]")
        ?.focus();
    }
    return { height, opacity, content };
  }

  override componentDidUpdate(
    _previous: SlidingDisclosureProps,
    _state: Readonly<unknown>,
    snapshot: DisclosureSnapshot | null,
  ) {
    if (snapshot) this.play(snapshot);
  }

  override componentWillUnmount() {
    this.cancelPendingFrame();
    this.animation?.cancel();
    this.reducedMotion?.removeEventListener("change", this.finish);
  }

  private cancelPendingFrame() {
    if (!this.pendingFrame) return;
    cancelAnimationFrame(this.pendingFrame);
    this.pendingFrame = 0;
    this.releaseHold();
  }

  private releaseHold() {
    const panel = this.panel.current;
    if (!panel) return;
    panel.style.height = "";
    panel.style.overflow = "";
  }

  private finish = () => {
    this.cancelPendingFrame();
    this.animation?.cancel();
    this.animation = null;
    const panel = this.panel.current;
    if (!panel) return;
    panel.style.overflow = "";
    panel.style.maskImage = "";
    panel.style.maskRepeat = "";
    if (!this.props.open) panel.replaceChildren();
  };

  private revealForFocus = () => {
    // Tab can reach a row before the opening clip does, or before the slide
    // has started; either way the rows show at once.
    if (this.props.open && (this.animation || this.pendingFrame)) this.finish();
  };

  private play(snapshot: DisclosureSnapshot) {
    const panel = this.panel.current;
    if (!panel) return;
    if (snapshot.content) panel.append(snapshot.content);
    if (typeof panel.animate !== "function") {
      this.finish();
      return;
    }
    if (!this.props.open) {
      this.slide(panel, snapshot);
      return;
    }
    // Opening rows settle their height after this commit: the windowed list
    // swaps its estimated placeholders for rows in a follow-up render. The
    // panel holds its starting height until the next frame, then measures
    // where to land and slides, before that frame paints.
    panel.style.height = `${snapshot.height}px`;
    panel.style.overflow = "clip";
    this.pendingFrame = requestAnimationFrame(() => {
      this.pendingFrame = 0;
      this.releaseHold();
      this.slide(panel, snapshot);
    });
  }

  private slide(panel: HTMLDivElement, snapshot: DisclosureSnapshot) {
    const open = this.props.open;
    // The open panel's laid-out height, not its scrollHeight: the tree guides
    // and sticky shields reach past the last row, and a slide that grows to
    // cover them snaps back when it ends.
    const destination = open ? panel.getBoundingClientRect().height : 0;
    panel.style.overflow = "clip";
    panel.style.maskImage = DISCLOSURE_EDGE_MASK;
    panel.style.maskRepeat = "no-repeat";
    const heights = this.reducedMotion?.matches
      ? [{}, {}]
      : [{ height: `${snapshot.height}px` }, { height: `${destination}px` }];
    const animation = panel.animate(
      [
        {
          ...heights[0],
          opacity: snapshot.opacity,
          filter: open ? DISCLOSURE_BLUR : "blur(0px)",
          maskSize: open ? EDGE_FADE_IN : EDGE_FADE_OUT,
        },
        {
          ...heights[1],
          opacity: open ? 1 : 0,
          filter: open ? "blur(0px)" : DISCLOSURE_BLUR,
          maskSize: open ? EDGE_FADE_OUT : EDGE_FADE_IN,
        },
      ],
      DISCLOSURE_TIMING,
    );
    this.animation = animation;
    void animation.finished.then(
      () => {
        if (this.animation === animation) this.finish();
        return undefined;
      },
      () => {},
    );
  }

  override render() {
    const { open, children } = this.props;
    return (
      <div
        ref={this.panel}
        data-gtd-disclosure=""
        onFocusCapture={this.revealForFocus}
        inert={!open}
        aria-hidden={open ? undefined : true}
        style={open ? OPEN_STYLE : CLOSED_STYLE}
      >
        {open ? children : null}
      </div>
    );
  }
}
