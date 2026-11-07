import { Component, createContext, createRef, type ContextType, type ReactNode } from "react";
import { blur } from "@animate-ui/react/utils/motion";
import {
  DISCLOSURE_START_EVENT,
  DISCLOSURE_TIMING,
  OPEN_FADE_TIMING,
} from "../../lib/disclosure-motion";

/** The fade at a sliding panel's bottom edge. */
const FADE = 16;

/**
 * How long a close of a panel this tall slides. A short panel keeps the fold's
 * pace; a tall one lands sooner, so the rows below move up about as fast as
 * when it swept its whole height. An open never outlasts its quick fade.
 */
function slideDuration(span: number): number {
  const long = Math.min(1, Math.max(0, (span - 200) / 200));
  return Math.round(DISCLOSURE_TIMING.duration + (180 - DISCLOSURE_TIMING.duration) * long);
}

/** Where the list's scroll viewport shows a panel. */
interface PanelView {
  scroller: HTMLElement | null;
  scrollTop: number;
  /**
   * Panel pixels above the line the list shows rows from: the scroller's
   * top edge, or the bottom of the shelf header pinned over the panel.
   */
  hidden: number;
  /** Pixels from that line, or the panel's top, to the scroller's bottom edge. */
  shown: number;
}

function viewPanel(panel: HTMLElement): PanelView {
  let scroller = panel.parentElement;
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  const edges = scroller?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight };
  const top = panel.getBoundingClientRect().top;
  const header = panel.previousElementSibling?.getBoundingClientRect().bottom ?? top;
  const line = Math.max(top, edges.top, header);
  return {
    scroller,
    scrollTop: scroller?.scrollTop ?? 0,
    hidden: line - top,
    shown: Math.max(0, edges.bottom - line),
  };
}

/**
 * The view a list shows and the view its last commit showed. A switch mounts
 * every open panel at once, so panels mounted by the commit that switches
 * appear in place instead of sliding in. The list updates `shown` in a passive
 * effect, after its panels mount.
 */
export interface DisclosureView {
  current: unknown;
  shown: { readonly current: unknown };
}

export const DisclosureViewContext = createContext<DisclosureView | null>(null);

interface SlidingDisclosureProps {
  open: boolean;
  children?: ReactNode;
}

interface DisclosureSnapshot {
  height: number;
  opacity: string;
  content: HTMLDivElement | null;
  /** Read before the fold commits: a closed panel's layout can clamp the scroll. */
  view: PanelView;
}

/**
 * Snapshot before React removes closing rows: retaining their React tree would
 * leave virtualizer measurement refs pointing at indexes the fold just removed.
 * The inert exit copy has no listeners or measurement/navigation identities.
 */
export class SlidingDisclosure extends Component<
  SlidingDisclosureProps,
  unknown,
  DisclosureSnapshot | null
> {
  static override contextType = DisclosureViewContext;
  declare context: ContextType<typeof DisclosureViewContext>;
  private panel = createRef<HTMLDivElement>();
  /** The fade, then the slide when motion is allowed. */
  private animations: Animation[] = [];
  private releaseScroll: (() => void) | null = null;
  private reducedMotion: MediaQueryList | null = null;

  override componentDidMount() {
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.finish);
    // The outer disclosure reveals newly mounted groups as one panel. Starting
    // inner height animations here would make its measured destination too short.
    const insideDisclosure = this.panel.current?.parentElement?.closest("[data-gtd-disclosure]");
    const panel = this.panel.current;
    const switching = this.context !== null && this.context.shown.current !== this.context.current;
    if (panel && this.props.open && !insideDisclosure && !switching) {
      this.play({ height: 0, opacity: "0", content: null, view: viewPanel(panel) });
    }
  }

  override getSnapshotBeforeUpdate(previous: SlidingDisclosureProps): DisclosureSnapshot | null {
    const panel = this.panel.current;
    if (!panel || previous.open === this.props.open) return null;
    const height = panel.getBoundingClientRect().height;
    const view = viewPanel(panel);
    const opacity = previous.open || this.animations.length ? getComputedStyle(panel).opacity : "0";
    const content = this.props.open ? null : panel.cloneNode(true);
    this.stop();
    // Clear a previous exit before React mounts the newly opened rows.
    if (!previous.open) panel.replaceChildren();
    if (!(content instanceof HTMLDivElement)) return { height, opacity, content: null, view };
    content.style.height = "auto";
    content.style.overflow = "visible";
    content.style.maskImage = "none";
    content.inert = true;
    for (const element of content.querySelectorAll("*")) {
      for (const attribute of element.getAttributeNames()) {
        if (
          attribute === "id" ||
          attribute === "data-index" ||
          attribute === "data-gtd-row" ||
          attribute.startsWith("data-sidebar-")
        ) {
          element.removeAttribute(attribute);
        }
      }
    }
    if (panel.contains(document.activeElement)) {
      panel.previousElementSibling
        ?.querySelector<HTMLButtonElement>("button[aria-expanded]")
        ?.focus();
    }
    return { height, opacity, content, view };
  }

  override componentDidUpdate(
    _previous: SlidingDisclosureProps,
    _state: Readonly<unknown>,
    snapshot: DisclosureSnapshot | null,
  ) {
    if (snapshot) this.play(snapshot);
  }

  override componentWillUnmount() {
    this.stop();
    if (this.reducedMotion) this.reducedMotion.removeEventListener("change", this.finish);
  }

  private stop() {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
    this.releaseScroll?.();
    this.releaseScroll = null;
  }

  private finish = () => {
    this.stop();
    const panel = this.panel.current;
    if (!panel) return;
    panel.style.overflow = "visible";
    panel.style.maskImage = "none";
    if (!this.props.open) panel.replaceChildren();
  };

  /** An opening slide ends: rows past it show, and the fade runs on. */
  private landSlide(slide: Animation) {
    this.releaseScroll?.();
    this.releaseScroll = null;
    const panel = this.panel.current;
    if (this.animations[1] !== slide || !panel) return;
    slide.cancel();
    this.animations = this.animations.slice(0, 1);
    panel.style.overflow = "visible";
    panel.style.maskImage = "none";
  }

  private revealForFocus = () => {
    // Tab can reach a row before the expanding clip reaches it.
    if (this.props.open && this.animations.length) this.finish();
  };

  private play(snapshot: DisclosureSnapshot) {
    const panel = this.panel.current;
    if (!panel) return;
    const { duration, easing } = DISCLOSURE_TIMING;
    const open = this.props.open;
    const { scroller, scrollTop, hidden, shown } = snapshot.view;
    const slide = !this.reducedMotion?.matches;
    // A tall group slid across its whole height would move hundreds of pixels
    // a frame. The slide spans only what the list shows, plus the fade, so
    // every fold moves at a shelf's pace and lands offscreen past the edge.
    // Closed from its pinned header, the part scrolled past drops at once
    // while the scroll moves up by as much, so the rows on screen hold still.
    const dropped = slide && !open && scroller ? Math.min(hidden, snapshot.height) : 0;
    const reach = hidden - dropped + shown + FADE;
    const from = Math.min(snapshot.height - dropped, reach);
    const destination = open ? Math.min(panel.scrollHeight, reach) : 0;
    if (snapshot.content) {
      if (dropped) snapshot.content.style.translate = `0 ${-dropped}px`;
      panel.append(snapshot.content);
    }
    panel.style.overflow = "clip";
    panel.style.maskImage = `linear-gradient(to bottom, #000 calc(100% - ${FADE}px), transparent)`;
    // An opening fold's rows read soon after the click; a close keeps the
    // fold's pace.
    const fade = panel.animate(
      [
        { opacity: snapshot.opacity, filter: open ? blur.disclosure : "blur(0px)" },
        { opacity: open ? 1 : 0, filter: open ? "blur(0px)" : blur.disclosure },
      ],
      open ? OPEN_FADE_TIMING : { duration, easing },
    );
    this.animations = [fade];
    // Once a slide lands, the panel's own height takes over: an open panel's
    // rows past the edge are offscreen, and a closed panel is already gone.
    if (slide) {
      const sliding = panel.animate([{ height: `${from}px` }, { height: `${destination}px` }], {
        duration: Math.min(
          slideDuration(Math.abs((open ? panel.scrollHeight : 0) - snapshot.height)),
          open ? OPEN_FADE_TIMING.duration : Infinity,
        ),
        easing,
      });
      this.animations.push(sliding);
      if (open) {
        const land = () => this.landSlide(sliding);
        void sliding.finished.then(land, () => {});
        // Scrolling down a group that runs past the edge would reach the
        // slide's end before it lands.
        if (scroller && destination < panel.scrollHeight) {
          scroller.addEventListener("scroll", land, { passive: true });
          this.releaseScroll = () => scroller.removeEventListener("scroll", land);
        }
      }
    }
    if (dropped && scroller) scroller.scrollTop = scrollTop - dropped;
    panel.dispatchEvent(new Event(DISCLOSURE_START_EVENT, { bubbles: true }));
    void fade.finished.then(
      () => {
        if (this.animations[0] === fade) this.finish();
        return undefined;
      },
      () => {},
    );
  }

  override render() {
    return (
      <div
        ref={this.panel}
        data-gtd-disclosure=""
        onFocusCapture={this.revealForFocus}
        inert={!this.props.open}
        aria-hidden={!this.props.open}
        style={{ height: this.props.open ? "auto" : 0 }}
      >
        {this.props.open ? this.props.children : null}
      </div>
    );
  }
}
