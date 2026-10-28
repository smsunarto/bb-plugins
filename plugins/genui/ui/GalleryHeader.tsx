// The top of the Gen-UI Gallery: one sticky header, two rows. BB's own page
// bar already names the gallery, so the header is navigation only.
//   - The top row is a search box on the index; on a component's page, back,
//     where you are ("Data / Chart / Funnel") and a search button.
//   - The chip row below it is the groups on the index (the one you're
//     reading is marked as you scroll; a tap jumps to it), and on a
//     component's page the other components of its group.
// Search opens a list under the top row on every page and phone alike: every
// component by group while the box is empty, the matches best first as you
// type (name, group, what it shows, an example's variant). Arrows move, Enter
// opens, Esc closes; "/" opens it from anywhere in the page.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { callSignature, COMPONENTS, type CatalogComponentSpec, type ComponentGroup, type ComponentName } from "../core/catalog";
import { variantName } from "./FrameFooter";
import { componentsIn, GALLERY_GROUPS, GALLERY_ORDER, searchComponents, type ComponentMatch } from "./gallery-search";
import { reducedMotion } from "./components/motion";

/** What the page shows, as the header names it. */
export type GallerySelection =
  | { readonly kind: "index" }
  | { readonly kind: "component"; readonly name: ComponentName }
  /** `variant` is "funnel" for Chart-funnel.ui. */
  | { readonly kind: "example"; readonly name: ComponentName; readonly variant: string }
  | { readonly kind: "missing"; readonly path: string };

/** Where each index section starts, for the group chips to jump to. */
export const groupAnchor = (group: ComponentGroup) => `genui-gallery-group-${group}`;

const FOCUS = "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
const ICON_BUTTON = cn(
  "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground [@media(pointer:coarse)]:size-11",
  FOCUS,
);
const FIELD = "h-9 rounded-lg border border-border [@media(pointer:coarse)]:h-11";
const KBD = "rounded border border-border px-1.5 font-mono text-[11px] leading-4 text-muted-foreground [@media(pointer:coarse)]:hidden";
/** Space kept between the header and a group heading it scrolls to, or the search list and the screen's bottom. */
const GAP = 12;

const summaryOf = (name: ComponentName): string => {
  const summary: string | undefined = (COMPONENTS[name] as CatalogComponentSpec).summary;
  return summary === undefined ? "" : summary.charAt(0).toUpperCase() + summary.slice(1);
};

export function GalleryHeader({
  selection,
  exampleCount,
  examples,
  scroller,
  onGo,
  onReload,
}: {
  selection: GallerySelection;
  /** Examples in the gallery; null while they are listed. */
  exampleCount: number | null;
  /** Each component's example files; empty while they are listed. */
  examples: ReadonlyMap<ComponentName, readonly string[]>;
  scroller: RefObject<HTMLDivElement | null>;
  /** Shows `""` (the index), a component, or one example (`Chart-funnel`). */
  onGo: (path: string) => void;
  onReload: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  const [readingGroup, setReadingGroup] = useState<ComponentGroup>(GALLERY_GROUPS[0]);
  const [listHeight, setListHeight] = useState(480);
  const header = useRef<HTMLDivElement>(null);
  const topRow = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const listId = useId();

  const current = selection.kind === "component" || selection.kind === "example" ? selection.name : null;
  const variants = useMemo(
    () => new Map([...examples].map(([name, files]) => [name, files.map((file) => file.replace(/\.ui$/, "").split("-").slice(1).join("-"))])),
    [examples],
  );
  const searching = query.trim() !== "";
  const options: readonly ComponentMatch[] = useMemo(
    () => (searching ? searchComponents(query, variants) : GALLERY_ORDER.map((name) => ({ name, kind: "name" as const, at: null }))),
    [searching, query, variants],
  );
  const browseIndex = current === null ? 0 : Math.max(0, GALLERY_ORDER.indexOf(current));

  const openSearch = () => {
    setActive(browseIndex);
    setOpen(true);
  };
  const close = (returnFocus: boolean) => {
    refocus.current = returnFocus;
    setOpen(false);
    setQuery("");
  };
  const go = (path: string) => {
    close(false);
    onGo(path);
  };

  // Esc gives focus back to the button that opened the search.
  useEffect(() => {
    if (open || !refocus.current) return;
    refocus.current = false;
    trigger.current?.focus();
  }, [open]);

  // "/" opens the search from anywhere in the page that isn't a text field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && (focused.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName))) return;
      if (focused !== null && focused !== document.body && !scroller.current?.contains(focused)) return;
      event.preventDefault();
      setActive(browseIndex);
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [scroller, browseIndex]);

  // While open: a press outside the header closes the list, which ends above the screen's bottom (or an iPhone's keyboard).
  useLayoutEffect(() => {
    if (!open) return;
    const fit = () => {
      const top = topRow.current?.getBoundingClientRect().bottom ?? 0;
      const view = window.visualViewport;
      const bottom = view === null ? window.innerHeight : view.offsetTop + view.height;
      // A phone gets the whole screen; with a mouse the list stays a dropdown.
      const cap = window.matchMedia("(pointer: coarse)").matches ? Infinity : 520;
      setListHeight(Math.max(160, Math.min(cap, Math.round(bottom - top - GAP))));
    };
    const onPress = (event: PointerEvent) => {
      if (event.target instanceof Node && !header.current?.contains(event.target)) close(false);
    };
    fit();
    window.visualViewport?.addEventListener("resize", fit);
    window.addEventListener("resize", fit);
    document.addEventListener("pointerdown", onPress);
    return () => {
      window.visualViewport?.removeEventListener("resize", fit);
      window.removeEventListener("resize", fit);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [open]);

  // The header's edge shows once the page scrolls under it; on the index, the group being read is marked.
  useEffect(() => {
    const root = scroller.current;
    if (root === null) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      setScrolled(root.scrollTop > 2);
      if (current !== null) return;
      const edge = (header.current?.getBoundingClientRect().bottom ?? 0) + GAP * 2;
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 2;
      const limit = atBottom ? root.getBoundingClientRect().bottom : edge;
      let reading = GALLERY_GROUPS[0];
      for (const group of GALLERY_GROUPS) {
        const top = document.getElementById(groupAnchor(group))?.getBoundingClientRect().top;
        if (top !== undefined && top <= limit) reading = group;
      }
      setReadingGroup(reading);
    };
    const onScroll = () => {
      frame ||= requestAnimationFrame(update);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => {
      root.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [scroller, current]);

  const jump = (group: ComponentGroup) => {
    const target = document.getElementById(groupAnchor(group));
    if (scroller.current === null || target === null) return;
    setReadingGroup(group);
    holdInView(scroller.current, target, (header.current?.offsetHeight ?? 0) + GAP);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length > 0) setActive((at) => (at + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const chosen = options[active];
      if (chosen !== undefined) go(chosen.name);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };

  const chips =
    current === null
      ? GALLERY_GROUPS.map((group) => ({ key: group, label: group, active: group === readingGroup, muted: false, onClick: () => jump(group) }))
      : componentsIn(COMPONENTS[current].group).map((name) => ({
          key: name,
          label: name,
          active: name === current,
          muted: examples.size > 0 && !examples.has(name),
          onClick: () => go(name),
        }));

  return (
    <>
      <div
        ref={header}
        className={cn(
          "@container sticky top-0 z-20 -mx-5 border-b bg-background px-5 transition-colors duration-150",
          scrolled ? "border-border" : "border-transparent",
        )}
      >
        <div ref={topRow} className="flex h-12 items-center gap-1 [@media(pointer:coarse)]:h-14">
          {open ? (
            <>
              <div className="relative min-w-0 flex-1">
                <Icon name="Search" aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  // Opened by a tap: focusing in the same task lets an iPhone raise its keyboard.
                  autoFocus
                  type="search"
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={options[active] === undefined ? undefined : `${listId}-${options[active].name}`}
                  aria-label="Search components by name, group or what they show"
                  placeholder="Search components"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(event.target.value.trim() === "" ? browseIndex : 0);
                  }}
                  onKeyDown={onKeyDown}
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(
                    FIELD,
                    "w-full appearance-none bg-background pl-8 pr-3 text-sm text-foreground caret-foreground placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden [@media(pointer:coarse)]:text-base",
                    FOCUS,
                  )}
                />
              </div>
              <button
                type="button"
                onClick={() => close(true)}
                className={cn(
                  "h-9 shrink-0 cursor-pointer rounded-md px-2.5 text-sm text-muted-foreground transition-colors duration-150 hover:text-foreground [@media(pointer:coarse)]:h-11",
                  FOCUS,
                )}
              >
                Cancel
              </button>
            </>
          ) : current === null ? (
            <>
              <h1 className="sr-only">Gen-UI Gallery</h1>
              <button
                ref={trigger}
                type="button"
                onClick={openSearch}
                aria-haspopup="listbox"
                className={cn(
                  FIELD,
                  "flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-2.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-state-hover",
                  FOCUS,
                )}
              >
                <Icon name="Search" aria-hidden className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Search {GALLERY_ORDER.length} components</span>
                <kbd aria-hidden className={KBD}>
                  /
                </kbd>
              </button>
              <ReloadButton onReload={onReload} />
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => go(selection.kind === "example" ? current : "")}
                aria-label={selection.kind === "example" ? `Back to ${current}` : "Back to all components"}
                title={selection.kind === "example" ? `Back to ${current}` : "All components"}
                className={cn(ICON_BUTTON, "-ml-2")}
              >
                <Icon name="ArrowLeft" aria-hidden className="size-4" />
              </button>
              <Trail selection={selection} name={current} onGo={go} />
              <button
                ref={trigger}
                type="button"
                onClick={openSearch}
                aria-haspopup="listbox"
                aria-label="Search components"
                className={cn(
                  ICON_BUTTON,
                  "@xl:h-8 @xl:w-48 @xl:justify-start @xl:gap-2 @xl:border @xl:border-border @xl:px-2.5 @xl:rounded-lg",
                )}
              >
                <Icon name="Search" aria-hidden className="size-4 shrink-0" />
                <span className="hidden text-sm @xl:inline">Search</span>
                <kbd aria-hidden className={cn(KBD, "ml-auto hidden @xl:inline")}>
                  /
                </kbd>
              </button>
              <span className="hidden @lg:contents">
                <ReloadButton onReload={onReload} />
              </span>
            </>
          )}
        </div>

        <ChipRow label={current === null ? null : COMPONENTS[current].group} chips={chips} activeKey={current ?? readingGroup} />

        {open ? (
          <SearchList
            id={listId}
            options={options}
            grouped={!searching}
            active={active}
            onActive={setActive}
            query={query}
            current={current}
            examples={examples}
            height={listHeight}
            onOpen={go}
          />
        ) : null}
      </div>

      {current === null ? (
        <p className="m-0 mt-4 text-xs leading-5 text-muted-foreground">
          {GALLERY_ORDER.length} components{exampleCount === null ? "" : `, ${exampleCount} examples`}, each drawn as it is in a
          reply. Buttons only show what they would send.
        </p>
      ) : (
        <Signature name={current} count={examples.get(current)?.length ?? null} />
      )}
    </>
  );
}

function ReloadButton({ onReload }: { onReload: () => void }) {
  return (
    <button type="button" onClick={onReload} title="Reload the examples" className={cn(ICON_BUTTON, "-mr-2")}>
      <Icon name="RotateCcw" aria-hidden className="size-4" />
      <span className="sr-only">Reload the examples</span>
    </button>
  );
}

/** "Data / Chart", and "/ Funnel" on one example's page; the group shows from 32rem of width (the chip row names it below). */
function Trail({ selection, name, onGo }: { selection: GallerySelection; name: ComponentName; onGo: (path: string) => void }) {
  const variant = selection.kind === "example" ? variantName(selection.variant) : null;
  const slash = (
    <li aria-hidden className="shrink-0 text-subtle-foreground">
      /
    </li>
  );
  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-sm">
        <li className="hidden shrink-0 text-muted-foreground @lg:block">{COMPONENTS[name].group}</li>
        <li aria-hidden className="hidden shrink-0 text-subtle-foreground @lg:block">
          /
        </li>
        <li className="min-w-0 shrink-0">
          {variant === null ? (
            <h1 aria-current="page" className="m-0 truncate text-sm font-semibold text-foreground">
              {name}
            </h1>
          ) : (
            <button
              type="button"
              onClick={() => onGo(name)}
              className={cn("cursor-pointer rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground", FOCUS)}
            >
              {name}
            </button>
          )}
        </li>
        {variant === null ? null : (
          <>
            {slash}
            <li className="min-w-0">
              <h1 aria-current="page" className="m-0 truncate text-sm font-semibold text-foreground">
                {variant}
              </h1>
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}

interface Chip {
  readonly key: string;
  readonly label: string;
  readonly active: boolean;
  /** A component with no example yet. */
  readonly muted: boolean;
  readonly onClick: () => void;
}

/** One line of chips that scrolls sideways, keeping the active one in view. */
function ChipRow({ label, chips, activeKey }: { label: string | null; chips: readonly Chip[]; activeKey: string }) {
  const row = useRef<HTMLDivElement>(null);
  const placed = useRef(false);

  useEffect(() => {
    const strip = row.current;
    const chip = strip?.querySelector<HTMLElement>(`[data-chip="${CSS.escape(activeKey)}"]`);
    if (strip == null || chip == null) return;
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    const inView = left >= strip.scrollLeft + 24 && right <= strip.scrollLeft + strip.clientWidth - 24;
    if (!inView) {
      strip.scrollTo({ left: left - (strip.clientWidth - chip.offsetWidth) / 2, behavior: placed.current && !reducedMotion() ? "smooth" : "auto" });
    }
    placed.current = true;
  }, [activeKey]);

  return (
    <div
      ref={row}
      role="navigation"
      aria-label={label === null ? "Groups" : `${label} components`}
      className="relative -mx-5 flex h-10 items-center gap-1 overflow-x-auto px-5 [mask-image:linear-gradient(to_right,transparent,#000_1.25rem,#000_calc(100%-1.25rem),transparent)] [scrollbar-width:none] [@media(pointer:coarse)]:h-12 [&::-webkit-scrollbar]:hidden"
    >
      {label === null ? null : <span className="shrink-0 pr-1.5 text-xs text-subtle-foreground @lg:hidden">{label}</span>}
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          data-chip={chip.key}
          aria-current={chip.active ? (label === null ? "location" : "page") : undefined}
          onClick={chip.onClick}
          className={cn(
            "h-7 shrink-0 cursor-pointer rounded-full px-3 text-xs transition-colors duration-150 [@media(pointer:coarse)]:h-9",
            FOCUS,
            chip.active
              ? "bg-foreground text-background"
              : cn("hover:bg-state-hover hover:text-foreground", chip.muted ? "text-subtle-foreground" : "text-muted-foreground"),
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The search's list, under the top row. Browsing (no query) it is every
 * component by group with the current one marked; searching, the matches
 * best first with their group. The input keeps focus: it owns the keys and
 * points at the highlighted option.
 */
function SearchList({
  id,
  options,
  grouped,
  active,
  onActive,
  query,
  current,
  examples,
  height,
  onOpen,
}: {
  id: string;
  options: readonly ComponentMatch[];
  grouped: boolean;
  active: number;
  onActive: (index: number) => void;
  query: string;
  current: ComponentName | null;
  examples: ReadonlyMap<ComponentName, readonly string[]>;
  height: number;
  onOpen: (name: ComponentName) => void;
}) {
  const list = useRef<HTMLDivElement>(null);

  // The highlighted option stays in view: centred when the list opens, nudged as the arrows move it.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const box = list.current;
    const option = box?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (box == null || option == null) return;
    const top = option.offsetTop;
    const bottom = top + option.offsetHeight;
    if (!opened.current) box.scrollTop = top - (box.clientHeight - option.offsetHeight) / 2;
    else if (top < box.scrollTop + 8) box.scrollTop = top - 8;
    else if (bottom > box.scrollTop + box.clientHeight - 8) box.scrollTop = bottom - box.clientHeight + 8;
    opened.current = true;
  }, [active, options]);

  const row = (match: ComponentMatch, index: number) => {
    const { name } = match;
    const count = examples.get(name)?.length ?? 0;
    return (
      <div
        key={name}
        id={`${id}-${name}`}
        role="option"
        aria-selected={index === active}
        aria-current={name === current ? "page" : undefined}
        data-index={index}
        onPointerMove={() => index !== active && onActive(index)}
        // Keeps focus in the input.
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => onOpen(name)}
        className={cn(
          "flex h-9 cursor-pointer items-center gap-3 rounded-md px-3 text-[13px] [@media(pointer:coarse)]:h-11",
          index === active ? "bg-state-hover" : undefined,
        )}
      >
        <span className={cn("w-32 shrink-0 truncate text-foreground", name === current && "font-semibold")}>{highlight(name, match, query)}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{summaryOf(name)}</span>
        {grouped ? (
          count > 1 ? (
            <span className="shrink-0 text-[11px] tabular-nums text-subtle-foreground">{count}</span>
          ) : null
        ) : (
          <span className="shrink-0 text-[11px] text-subtle-foreground">{COMPONENTS[name].group}</span>
        )}
      </div>
    );
  };

  return (
    <div
      className="absolute inset-x-2 top-12 z-30 flex flex-col overflow-hidden rounded-xl border border-border bg-surface-raised-solid shadow-lg @xl:inset-x-5 [@media(pointer:coarse)]:top-14"
      style={{ maxHeight: height }}
    >
      <p aria-live="polite" className="sr-only">
        {grouped ? "" : options.length === 0 ? "No component matches." : `${options.length} found. Enter opens ${options[0].name}.`}
      </p>
      <div ref={list} id={id} role="listbox" aria-label="Components" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
        {options.length === 0 ? (
          <p className="m-0 px-3 py-3 text-sm text-muted-foreground">
            No component matches “{query.trim()}”. Try what it shows, like “kanban” or “lcov”.
          </p>
        ) : grouped ? (
          GALLERY_GROUPS.map((group) => (
            <div key={group} role="group" aria-labelledby={`${id}-${group}`}>
              <p id={`${id}-${group}`} className="m-0 px-3 pb-1 pt-3 text-[11px] font-medium text-muted-foreground first:pt-2">
                {group}
              </p>
              {componentsIn(group).map((name) => row(options[GALLERY_ORDER.indexOf(name)], GALLERY_ORDER.indexOf(name)))}
            </div>
          ))
        ) : (
          options.map(row)
        )}
      </div>
      <p aria-hidden className="m-0 flex gap-3 border-t border-border px-4 py-2 text-[11px] text-subtle-foreground [@media(pointer:coarse)]:hidden">
        <span>↑↓ move</span>
        <span>Enter open</span>
        <span>Esc close</span>
      </p>
    </div>
  );
}

/**
 * Scrolls `scroller` (and nothing around it: scrollIntoView would also move
 * BB's own page) so `target` starts `offset` px below its top, and keeps it
 * there while examples above it mount and change height, for two seconds or
 * until the user scrolls.
 */
function holdInView(scroller: HTMLElement, target: HTMLElement, offset: number) {
  const align = () => {
    scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
  };
  align();
  const observer = new ResizeObserver(align);
  observer.observe(scroller.firstElementChild ?? scroller);
  const userEvents = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
  const stop = () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const name of userEvents) scroller.removeEventListener(name, stop);
  };
  const timer = setTimeout(stop, 2000);
  for (const name of userEvents) scroller.addEventListener(name, stop, { passive: true });
}

/** What the component is for, then its call and how many examples follow. */
function Signature({ name, count }: { name: ComponentName; count: number | null }) {
  const spec: CatalogComponentSpec = COMPONENTS[name];
  return (
    <div className="mt-4 flex flex-col gap-1">
      {spec.summary === undefined ? null : <p className="m-0 max-w-[62ch] text-sm leading-6 text-muted-foreground">{summaryOf(name)}</p>}
      <p className="m-0 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <code className="min-w-0 break-words font-mono text-xs leading-5 text-foreground">{withBreaks(callSignature(name, spec))}</code>
        {count === null ? null : <span className="text-xs text-subtle-foreground">{count === 1 ? "1 example" : `${count} examples`}</span>}
      </p>
    </div>
  );
}

/** A call signature that may wrap after `(`, `,` and `|`, never inside a name. */
function withBreaks(signature: string): ReactNode {
  return signature.split(/(?<=[(,|])/).map((part, index) => (
    <span key={index}>
      {index > 0 ? <wbr /> : null}
      {part}
    </span>
  ));
}

/** The name with the part the search matched in bold. */
function highlight(name: string, match: ComponentMatch, query: string): ReactNode {
  if (match.at === null || query.trim() === "") return name;
  const end = match.at + query.trim().length;
  return (
    <>
      {name.slice(0, match.at)}
      <mark className="bg-transparent font-semibold text-foreground">{name.slice(match.at, end)}</mark>
      {name.slice(end)}
    </>
  );
}
