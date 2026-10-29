// Adapted from T3 Code's TraitsPicker.tsx: the effort word that reads on from the
// model name, opening Codex's effort slider. The desktop menu is Codex's panel, with a
// reset button beside the level's name; the phone sheet has a larger slider. Speed lives
// in the model picker (SpeedToggle).
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRef, type KeyboardEvent } from "react";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { EffortSlider } from "./EffortSlider";
import type { Traits } from "./traits";

/** Keys that adjust the slider; Up and Down move between it and the reset button. */
const SLIDER_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

export function TraitsPicker(props: {
  effort: Traits["effort"];
  disabled?: boolean;
  onEffortChange(level: string): void | Promise<unknown>;
}) {
  const { effort } = props;
  // The same breakpoint at which DropdownMenuContent renders as a bottom sheet.
  const isSheet = useIsCompactViewport();
  const contentRef = useRef<HTMLDivElement>(null);
  if (!effort) return null;
  const effortWord =
    effort.options.find((option) => option.id === effort.current)?.label ?? effort.current;
  const slider = () => contentRef.current?.querySelector<HTMLElement>('[role="slider"]');
  const reset = () =>
    contentRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])');
  const defaultEffort = effort.options.find((option) => option.isDefault);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={props.disabled}
          aria-label={effortWord ? `Effort: ${effortWord}` : "Effort"}
          title={effortWord ? `Effort: ${effortWord}` : undefined}
          data-t3-traits-trigger=""
          data-t3-traits-word={effortWord ? "" : undefined}
          className="shrink-0 whitespace-nowrap"
        >
          {effortWord ?? "Effort"}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={contentRef}
        data-t3-composer-menu=""
        align="start"
        mobileTitle="Effort"
        className={isSheet ? undefined : "max-w-none"}
        onKeyDown={(event) => {
          if (isSheet) return;
          const target = panelKeyTarget(event, reset(), slider());
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <EffortSlider
          options={effort.options}
          current={effort.current}
          large={isSheet}
          focusFromKeyboard={!isSheet}
          onChange={props.onEffortChange}
          trailing={
            !isSheet && defaultEffort ? (
              <ResetButton
                label={`Reset effort to ${defaultEffort.label}`}
                // Hidden and disabled at the default rather than unmounted, so a hovered or
                // focused reset never vanishes from under the pointer or the keyboard.
                hidden={effort.current === defaultEffort.id}
                onSelect={() => {
                  // Keep focus in the panel once the default applies and the button hides.
                  slider()?.focus();
                  void props.onEffortChange(defaultEffort.id);
                }}
              />
            ) : null
          }
          {...(isSheet ? {} : { onArrowUpDown: () => reset()?.focus() })}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Where an arrow key in the desktop panel moves focus. After a pointer open the menu itself has
 * focus: Left, Right, Home and End go to the slider, and Up and Down reach the reset button
 * through Radix, or the slider when reset is hidden. ArrowDown on reset returns to the slider.
 */
function panelKeyTarget(
  event: KeyboardEvent<HTMLDivElement>,
  reset: HTMLElement | null | undefined,
  slider: HTMLElement | null | undefined,
) {
  if (event.target === event.currentTarget) {
    return SLIDER_KEYS.has(event.key) || (!reset && event.key.startsWith("Arrow")) ? slider : null;
  }
  return event.target === reset && event.key === "ArrowDown" ? slider : null;
}

/** The panel's reset button; a menu item so the menu's arrow keys reach it. */
function ResetButton(props: { label: string; hidden: boolean; onSelect(): void }) {
  return (
    <DropdownMenuItem
      aria-label={props.label}
      title={props.label}
      // Typeahead matches this text; the icon gives the item none of its own.
      textValue={props.label}
      disabled={props.hidden}
      aria-hidden={props.hidden || undefined}
      // The panel stays open, as Codex's does.
      onSelect={(event) => {
        event.preventDefault();
        props.onSelect();
      }}
      className={cn(
        "size-8 justify-center rounded-md p-0 text-muted-foreground data-[highlighted]:text-foreground",
        props.hidden && "invisible",
      )}
    >
      <Icon name="RotateCcw" className="size-4" aria-hidden />
    </DropdownMenuItem>
  );
}
