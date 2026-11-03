import { Component, createRef, type ReactNode } from "react";
import { blur } from "@animate-ui/react/utils/motion";
import { DISCLOSURE_START_EVENT, DISCLOSURE_TIMING } from "../../lib/disclosure-motion";

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
 * Snapshot before React removes closing rows: retaining their React tree would
 * leave virtualizer measurement refs pointing at indexes the fold just removed.
 * The inert exit copy has no listeners or measurement/navigation identities.
 */
export class SlidingDisclosure extends Component<
  SlidingDisclosureProps,
  unknown,
  DisclosureSnapshot | null
> {
  private panel = createRef<HTMLDivElement>();
  private animation: Animation | null = null;
  private reducedMotion: MediaQueryList | null = null;

  override componentDidMount() {
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion.addEventListener("change", this.finish);
    // The outer disclosure reveals newly mounted groups as one panel. Starting
    // inner height animations here would make its measured destination too short.
    const insideDisclosure = this.panel.current?.parentElement?.closest("[data-gtd-disclosure]");
    if (this.props.open && !insideDisclosure) this.play({ height: 0, opacity: "0", content: null });
  }

  override getSnapshotBeforeUpdate(previous: SlidingDisclosureProps): DisclosureSnapshot | null {
    const panel = this.panel.current;
    if (!panel || previous.open === this.props.open) return null;
    const height = panel.getBoundingClientRect().height;
    const opacity = previous.open || this.animation ? getComputedStyle(panel).opacity : "0";
    const content = this.props.open ? null : panel.cloneNode(true);
    this.animation?.cancel();
    this.animation = null;
    // Clear a previous exit before React mounts the newly opened rows.
    if (!previous.open) panel.replaceChildren();
    if (!(content instanceof HTMLDivElement)) return { height, opacity, content: null };
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
    this.animation?.cancel();
    if (this.reducedMotion) this.reducedMotion.removeEventListener("change", this.finish);
  }

  private finish = () => {
    this.animation?.cancel();
    this.animation = null;
    const panel = this.panel.current;
    if (!panel) return;
    panel.style.overflow = "visible";
    panel.style.maskImage = "none";
    if (!this.props.open) panel.replaceChildren();
  };

  private revealForFocus = () => {
    // Tab can reach a row before the expanding clip reaches it.
    if (this.props.open && this.animation) this.finish();
  };

  private play(snapshot: DisclosureSnapshot) {
    const panel = this.panel.current;
    if (!panel) return;
    if (snapshot.content) panel.append(snapshot.content);
    const { duration, easing } = DISCLOSURE_TIMING;
    const open = this.props.open;
    const destination = open ? panel.scrollHeight : 0;
    panel.style.overflow = "clip";
    panel.style.maskImage = "linear-gradient(to bottom, #000 calc(100% - 16px), transparent)";
    const heights = this.reducedMotion?.matches
      ? [{}, {}]
      : [{ height: `${snapshot.height}px` }, { height: `${destination}px` }];
    const animation = panel.animate(
      [
        { ...heights[0], opacity: snapshot.opacity, filter: open ? blur.disclosure : "blur(0px)" },
        { ...heights[1], opacity: open ? 1 : 0, filter: open ? "blur(0px)" : blur.disclosure },
      ],
      { duration, easing },
    );
    this.animation = animation;
    panel.dispatchEvent(new Event(DISCLOSURE_START_EVENT, { bubbles: true }));
    void animation.finished.then(
      () => {
        if (this.animation === animation) this.finish();
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
