// Adapted from T3 Code's ProviderModelPicker.tsx, ModelPickerContent.tsx,
// ModelPickerSidebar.tsx and ModelListRow.tsx. On a phone the picker opens as a bottom sheet,
// like the effort panel, without the search box, whose keyboard would cover the list.
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { experimental_ProviderIcon as ProviderIcon } from "@get-bb/plugin-sdk/app";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { useCloseWhenAnchorDetaches } from "@/components/ui/overlay-anchor";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MobileTrigger, ResponsiveDrawerShell } from "@/components/ui/responsive-overlay";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  findCatalogModel,
  type CatalogModel,
  type CatalogProvider,
  type ModelCatalog,
} from "./catalog";
import { favoriteKey, useFavoriteModels } from "./favorites";
import { rankModelSearch } from "./model-search";

type Tab = "favorites" | string;

interface PickerItem {
  key: string;
  provider: CatalogProvider;
  model: CatalogModel;
  isFavorite: boolean;
}

const JUMP_KEY_COUNT = 9;
// Rendered heights in `--spacing` units (4px), as in T3 Code: rows, the gap
// between rows, and the search box plus list padding and border.
const ONE_LINE_ROW_UNITS = 8;
const TWO_LINE_ROW_UNITS = 12;
const ROW_SEPARATOR_UNITS = 0.5;
const LIST_CHROME_UNITS = 15.5;
const MAX_HEIGHT_UNITS = 86.5;

function isMacPlatform() {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

function jumpLabel(index: number) {
  return isMacPlatform() ? `⌘${index + 1}` : `Ctrl+${index + 1}`;
}

function tabHeightUnits(rowsByTab: Map<Tab, number[]>) {
  let tallest = 0;
  for (const rows of rowsByTab.values()) {
    const units = rows.reduce(
      (sum, row, index) => sum + row + (index > 0 ? ROW_SEPARATOR_UNITS : 0),
      0,
    );
    tallest = Math.max(tallest, units);
  }
  return Math.min(tallest + LIST_CHROME_UNITS, MAX_HEIGHT_UNITS);
}

export function ModelPicker(props: {
  catalog: ModelCatalog;
  providerId: string | undefined;
  model: string | undefined;
  disabled?: boolean;
  onSelect(providerId: string, model: string): void;
}) {
  const { catalog } = props;
  // The same breakpoint at which the effort panel renders as a bottom sheet.
  const isSheet = useIsCompactViewport();
  const [open, setOpen] = useState(false);
  // The sheet keeps its contents mounted after it first opens; a new key per opening starts
  // each one on the current provider's tab, as the popover does.
  const [openings, setOpenings] = useState(0);
  const setOpenUnlessDisabled = (next: boolean) => {
    const opening = next && !props.disabled;
    if (opening && !open) setOpenings((count) => count + 1);
    setOpen(opening);
  };
  // Close when BB hides the composer, as it does while the agent waits on a question.
  const triggerRef = useCloseWhenAnchorDetaches<HTMLButtonElement>(null, open, setOpen);
  const activeProvider = catalog.providers.find((provider) => provider.id === props.providerId);
  const activeModel = props.providerId
    ? findCatalogModel(catalog.catalogFor(props.providerId).models, props.model)
    : undefined;
  const triggerLabel = activeModel?.displayName ?? props.model ?? "Choose model";
  // Load while open, and again once a late routing or provider list arrives.
  const loadAll = useEffectEvent(() => catalog.loadAll());
  useEffect(() => {
    if (open) loadAll();
  }, [open, catalog.revision]);

  const trigger = (
    <button
      ref={triggerRef}
      type="button"
      disabled={props.disabled}
      aria-label={triggerLabel}
      data-t3-model-picker-trigger=""
      className="min-w-0 max-w-48 shrink justify-between whitespace-nowrap sm:max-w-56"
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {activeProvider ? (
          <ProviderIcon
            providerKind="agent"
            provider={activeProvider}
            className="size-4 shrink-0"
            aria-hidden
          />
        ) : null}
        <span className="min-w-0 flex-1 truncate" data-t3-model-picker-label="">
          {triggerLabel}
        </span>
      </span>
    </button>
  );
  const content = (
    <ModelPickerContent
      key={isSheet ? openings : undefined}
      catalog={catalog}
      providerId={props.providerId}
      model={activeModel?.model ?? props.model}
      sheet={isSheet}
      onSelect={(providerId, model) => {
        props.onSelect(providerId, model);
        setOpen(false);
      }}
    />
  );

  if (isSheet) {
    return (
      <>
        <MobileTrigger asChild open={open} onOpenChange={setOpenUnlessDisabled} haspopup="dialog">
          {trigger}
        </MobileTrigger>
        <ResponsiveDrawerShell open={open} onOpenChange={setOpen} srLabel="Model">
          {content}
        </ResponsiveDrawerShell>
      </>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpenUnlessDisabled}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{triggerLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent
        data-t3-model-picker-popover=""
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLInputElement>("[data-t3-model-search]")
            ?.focus({ preventScroll: true });
        }}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}

function ModelPickerContent(props: {
  catalog: ModelCatalog;
  providerId: string | undefined;
  model: string | undefined;
  /** The phone sheet: no search box or jump keys, taller rows, and a fixed height. */
  sheet: boolean;
  onSelect(providerId: string, model: string): void;
}) {
  const { catalog, sheet } = props;
  const { favorites, toggle } = useFavoriteModels();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>(() =>
    favorites.size > 0
      ? "favorites"
      : (props.providerId ?? catalog.providers[0]?.id ?? "favorites"),
  );
  // The highlight follows a model, not a row, so re-sorting (favoriting) keeps it in place.
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const idPrefix = useId();
  const listId = `${idPrefix}-models`;
  const hintId = `${idPrefix}-hint`;
  const optionId = (index: number) => `${idPrefix}-model-${index}`;
  const searchRef = useRef<HTMLInputElement>(null);
  const isSearching = query.trim().length > 0;
  const activeKey =
    props.providerId && props.model ? favoriteKey(props.providerId, props.model) : null;

  // A provider that is not ready cannot take a pick, so its models stay out of search and Favorites.
  const selectableProviders = catalog.providers.filter(
    (provider) => provider.available || provider.id === props.providerId,
  );
  const allItems: PickerItem[] = selectableProviders.flatMap((provider) =>
    catalog.catalogFor(provider.id).models.map((model) => {
      const key = favoriteKey(provider.id, model.model);
      return { key, provider, model, isFavorite: favorites.has(key) };
    }),
  );
  const rowsByTab = new Map<Tab, number[]>();
  for (const item of allItems) {
    rowsByTab.set(item.provider.id, [
      ...(rowsByTab.get(item.provider.id) ?? []),
      ONE_LINE_ROW_UNITS,
    ]);
    if (item.isFavorite)
      rowsByTab.set("favorites", [...(rowsByTab.get("favorites") ?? []), TWO_LINE_ROW_UNITS]);
  }
  // Fit the tallest tab so switching tabs never resizes the popup under the cursor.
  const minHeightUnits = tabHeightUnits(rowsByTab);

  const visibleItems = isSearching
    ? rankModelSearch(allItems, query, (item) => ({
        name: item.model.displayName,
        model: item.model.model,
        providerName: item.provider.displayName,
        isFavorite: item.isFavorite,
      }))
    : tab === "favorites"
      ? allItems.filter((item) => item.isFavorite)
      : // Favorites lead inside a provider's tab, as in T3 Code.
        allItems
          .filter((item) => item.provider.id === tab)
          .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite));
  const rowsMixProviders = isSearching || tab === "favorites";
  const highlightIndex = Math.max(
    0,
    visibleItems.findIndex((item) => item.key === highlightedKey),
  );
  // The sheet's Tab stop: the chosen model, or the first row.
  const tabStopIndex = Math.max(
    0,
    visibleItems.findIndex((item) => item.key === activeKey),
  );
  const tabCatalog = !isSearching && tab !== "favorites" ? catalog.catalogFor(tab) : null;

  const [resetFor, setResetFor] = useState(`${tab}\u0000${query}`);
  if (resetFor !== `${tab}\u0000${query}`) {
    setResetFor(`${tab}\u0000${query}`);
    setHighlightedKey(null);
  }

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlightIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [highlightIndex]);

  const select = (item: PickerItem | undefined) => {
    if (item) props.onSelect(item.provider.id, item.model.model);
  };

  // Capture gives the jump shortcuts priority over the composer underneath.
  const onJumpKey = useEffectEvent((event: KeyboardEvent) => {
    // The sheet shows no jump keys, and stays mounted while closed.
    if (sheet || event.repeat || event.altKey || event.shiftKey) return;
    if (!(isMacPlatform() ? event.metaKey : event.ctrlKey)) return;
    const index = Number(event.key) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= JUMP_KEY_COUNT) return;
    const item = visibleItems[index];
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    select(item);
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onJumpKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);

  const selectTab = (next: Tab) => {
    setTab(next);
    setQuery("");
    requestAnimationFrame(() => searchRef.current?.focus({ preventScroll: true }));
  };

  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Enter and arrows belong to an input method while it composes.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    const modifier = isMacPlatform() ? event.metaKey : event.ctrlKey;
    if (modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "d") {
      event.preventDefault();
      const item = visibleItems[highlightIndex];
      if (item) toggle(item.provider.id, item.model.model);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const count = visibleItems.length;
      if (count > 0) setHighlightedKey(visibleItems[(highlightIndex + delta + count) % count]!.key);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      select(visibleItems[highlightIndex]);
      return;
    }
    if (
      !isSearching &&
      ((event.key === "ArrowLeft" && query.length === 0) || (event.key === "Tab" && event.shiftKey))
    ) {
      const rail = event.currentTarget
        .closest("[data-t3-model-picker]")
        ?.querySelector("[data-t3-model-picker-rail]");
      const button =
        rail?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)') ??
        rail?.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (button) {
        event.preventDefault();
        button.focus();
      }
    }
  };

  return (
    <TooltipProvider delayDuration={0}>
      <div
        data-t3-model-picker=""
        className={cn(
          "relative flex flex-row overflow-hidden",
          // A fixed height, so switching tabs never resizes the sheet under the thumb.
          sheet ? "h-[min(28rem,70dvh)] w-full" : "max-h-[346px] w-screen max-w-[360px]",
        )}
        style={sheet ? undefined : { minHeight: `calc(${minHeightUnits} * 4px + 1px)` }}
      >
        {!isSearching && catalog.providers.length > 0 ? (
          <ProviderRail
            providers={catalog.providers}
            sheet={sheet}
            tab={tab}
            onSelectTab={selectTab}
            onFocusSearch={() =>
              (
                searchRef.current ??
                listRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')
              )?.focus()
            }
          />
        ) : null}
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
            // The sheet keeps its own background, as the effort sheet does.
            !sheet && "bg-muted/40",
            !isSearching && "border-l border-border/70",
          )}
        >
          {sheet ? null : (
            <div className="min-w-0 shrink-0 px-3 pt-2.5">
              <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                <Icon
                  name="Search"
                  aria-hidden
                  className="pointer-events-none absolute left-0 top-1.5 size-4 shrink-0 text-muted-foreground/55"
                />
                <input
                  ref={searchRef}
                  data-t3-model-search=""
                  type="text"
                  role="combobox"
                  aria-label="Search models"
                  aria-expanded="true"
                  aria-haspopup="listbox"
                  aria-autocomplete="list"
                  aria-controls={listId}
                  aria-activedescendant={
                    visibleItems[highlightIndex] ? optionId(highlightIndex) : undefined
                  }
                  aria-describedby={hintId}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Search models..."
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={onSearchKeyDown}
                  className="h-[26px] w-full bg-transparent ps-5 font-sans text-sm leading-[26px] text-foreground outline-none placeholder:text-muted-foreground/70"
                />
                <span id={hintId} className="sr-only">
                  Up and Down to move, Enter to choose, {isMacPlatform() ? "Command" : "Control"}+D
                  to add or remove a favorite.
                </span>
              </div>
            </div>
          )}
          {/* A native <select> cannot show provider lines, jump keys or stars; the search box drives this listbox through aria-activedescendant. */}
          <div
            ref={listRef}
            id={listId}
            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- see the comment above.
            role="listbox"
            aria-label="Models"
            className={cn(
              "min-h-0 overflow-y-auto overscroll-y-contain py-1.5 pl-2 pr-px [scrollbar-gutter:stable]",
              sheet && "pb-3",
              visibleItems.length > 0 ? "flex-1" : "h-0",
            )}
          >
            <div className="flex flex-col gap-0.5">
              {visibleItems.map((item, index) => (
                <ModelRow
                  key={item.key}
                  id={optionId(index)}
                  index={index}
                  item={item}
                  // Touch has no keyboard highlight to show; a press shows instead.
                  highlighted={!sheet && index === highlightIndex}
                  selected={item.key === activeKey}
                  tabStop={index === tabStopIndex}
                  showProvider={rowsMixProviders}
                  large={sheet}
                  jumpLabel={!sheet && index < JUMP_KEY_COUNT ? jumpLabel(index) : null}
                  // A touch scroll moves the pointer too; following it would scroll the list.
                  onHighlight={sheet ? undefined : () => setHighlightedKey(item.key)}
                  onSelect={() => select(item)}
                  onToggleFavorite={() => toggle(item.provider.id, item.model.model)}
                />
              ))}
            </div>
          </div>
          <ListNotice
            visibleCount={visibleItems.length}
            tabCatalog={tabCatalog}
            emptyLabel={
              tab === "favorites" && !isSearching ? "No favorites yet" : "No models found"
            }
            onRetry={() => catalog.loadAll({ force: true })}
          />
        </div>
      </div>
    </TooltipProvider>
  );
}

function ListNotice(props: {
  visibleCount: number;
  tabCatalog: ReturnType<ModelCatalog["catalogFor"]> | null;
  emptyLabel: string;
  onRetry(): void;
}) {
  const { tabCatalog } = props;
  if (tabCatalog?.status === "error") {
    return (
      <div className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground">
        <p className="line-clamp-3">{tabCatalog.message}</p>
        <button
          type="button"
          onClick={props.onRetry}
          className="mt-1 font-medium text-foreground underline-offset-2 hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }
  if (props.visibleCount > 0) return null;
  return (
    <p className="p-2 text-center text-sm text-muted-foreground">
      {tabCatalog?.status === "loading" ? "Loading models…" : props.emptyLabel}
    </p>
  );
}

function ModelRow(props: {
  id: string;
  index: number;
  item: PickerItem;
  highlighted: boolean;
  selected: boolean;
  showProvider: boolean;
  /** A touch-sized row, for the phone sheet. */
  large: boolean;
  /** The sheet's one Tab stop in the list; arrow keys move between rows from there. */
  tabStop: boolean;
  jumpLabel: string | null;
  onHighlight?(): void;
  onSelect(): void;
  onToggleFavorite(): void;
}) {
  const { item } = props;
  const favoriteLabel = item.isFavorite ? "Remove from favorites" : "Add to favorites";
  return (
    // The search box keeps focus and owns the keys through aria-activedescendant.
    <div
      id={props.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a native <option> cannot hold the star and jump key.
      role="option"
      // Without the search box, the sheet's rows take focus themselves.
      tabIndex={props.large && props.tabStop ? 0 : -1}
      aria-selected={props.selected}
      data-index={props.index}
      data-highlighted={props.highlighted ? "" : undefined}
      onPointerMove={props.onHighlight}
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        // Reached in the sheet, or if an assistive tool focuses the option itself.
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          const sibling =
            event.key === "ArrowDown"
              ? event.currentTarget.nextElementSibling
              : event.currentTarget.previousElementSibling;
          if (sibling instanceof HTMLElement) {
            event.preventDefault();
            sibling.focus();
          }
          return;
        }
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        props.onSelect();
      }}
      className={cn(
        "group relative flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm",
        props.large
          ? "min-h-11 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring active:bg-foreground/[0.09]"
          : "min-h-7 py-1",
        props.selected && "bg-foreground/[0.06] text-foreground",
        props.highlighted && "bg-foreground/[0.09] text-accent-foreground",
      )}
    >
      <div className="min-w-0 flex-1 text-left">
        <div className="min-w-0 truncate text-sm font-normal leading-snug">
          {item.model.displayName}
        </div>
        {props.showProvider ? (
          <div className="mt-1 flex items-center gap-1.5">
            <ProviderIcon
              providerKind="agent"
              provider={item.provider}
              className="size-3 shrink-0"
              aria-hidden
            />
            <span className="truncate text-xs font-normal leading-snug text-muted-foreground/70">
              {item.provider.displayName}
            </span>
          </div>
        ) : null}
        {item.isFavorite ? <span className="sr-only">, favorite</span> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {props.jumpLabel ? (
          <kbd
            aria-hidden
            className="pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center rounded bg-foreground/[0.07] px-1 font-sans text-xs font-medium text-muted-foreground"
          >
            {props.jumpLabel}
          </kbd>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Pointer shortcut; keyboard users favorite the highlighted model with Mod+D. */}
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              data-t3-favorite-toggle={item.isFavorite ? "on" : "off"}
              onClick={(event) => {
                event.stopPropagation();
                props.onToggleFavorite();
              }}
              className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
            >
              <Icon
                name="Star"
                className={cn(
                  "size-3",
                  item.isFavorite
                    ? "fill-current text-warning"
                    : "opacity-0 group-hover:opacity-100 group-data-[highlighted]:opacity-100 [@media(pointer:coarse)]:opacity-100",
                )}
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{favoriteLabel}</TooltipContent>
        </Tooltip>
        {/* Last, and always reserved, so stars and the check keep fixed columns. */}
        <Icon name="Check" aria-hidden className={cn("size-3.5", !props.selected && "invisible")} />
      </div>
    </div>
  );
}

function ProviderRail(props: {
  providers: readonly CatalogProvider[];
  sheet: boolean;
  tab: Tab;
  onSelectTab(tab: Tab): void;
  onFocusSearch(): void;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [indicatorTop, setIndicatorTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const selected = [
      ...(contentRef.current?.querySelectorAll<HTMLElement>("[data-t3-rail-tab]") ?? []),
    ].find((element) => element.dataset.t3RailTab === props.tab);
    setIndicatorTop(selected ? selected.offsetTop + selected.offsetHeight / 2 - 10 : null);
  }, [props.providers, props.tab]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      props.onFocusSearch();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [
      ...(contentRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length];
    next?.focus();
  };

  return (
    <div
      data-t3-model-picker-rail=""
      className={cn("w-11 shrink-0 overflow-hidden", !props.sheet && "bg-muted/30")}
    >
      <div className="h-full overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div ref={contentRef} className="relative flex min-h-full flex-col gap-1 p-1">
          {indicatorTop !== null ? (
            <div
              aria-hidden
              className="pointer-events-none absolute right-1 z-10 h-5 w-[3px] rounded-full bg-primary transition-[top] duration-200 ease-out"
              style={{ top: indicatorTop }}
            />
          ) : null}
          <RailButton
            tab="favorites"
            label="Favorites"
            selected={props.tab === "favorites"}
            onSelect={props.onSelectTab}
            onKeyDown={onKeyDown}
          >
            <Icon name="Star" aria-hidden className="size-5 shrink-0 fill-current" />
          </RailButton>
          <div className="border-b border-border/70" aria-hidden />
          {props.providers.map((provider) => (
            <RailButton
              key={provider.id}
              tab={provider.id}
              label={
                provider.available ? provider.displayName : `${provider.displayName}: Not ready.`
              }
              selected={props.tab === provider.id}
              disabled={!provider.available}
              onSelect={props.onSelectTab}
              onKeyDown={onKeyDown}
            >
              <ProviderIcon
                providerKind="agent"
                provider={provider}
                className="size-5"
                aria-hidden
              />
            </RailButton>
          ))}
        </div>
      </div>
    </div>
  );
}

function RailButton(props: {
  tab: Tab;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onSelect(tab: Tab): void;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>): void;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.selected}
      disabled={props.disabled}
      onClick={() => props.onSelect(props.tab)}
      onKeyDown={props.onKeyDown}
      className={cn(
        "relative isolate flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-foreground/10 focus-visible:bg-foreground/10 focus-visible:outline-none",
        props.disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      {props.children}
    </button>
  );
  return (
    <div className="relative w-full" data-t3-rail-tab={props.tab}>
      <Tooltip>
        <TooltipTrigger asChild>
          {props.disabled ? <span className="relative block w-full">{button}</span> : button}
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          {props.label}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
