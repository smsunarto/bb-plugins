import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  AVATAR_COLORS,
  AVATAR_COLOR_LABELS,
  AVATAR_EXPRESSIONS,
  AVATAR_MOTIONS,
  AVATAR_SHAPES,
  type BotAvatar,
} from "../lib/appearance";
import { BotIcon } from "./bot-icon";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const TILE_CLASS =
  "h-11 w-full rounded-md border border-transparent first:rounded-md first:border-l last:rounded-md data-[state=on]:border-primary [&_svg]:size-8";

export function AvatarAppearance({
  avatar,
  onChange,
}: {
  avatar: BotAvatar;
  onChange: (avatar: BotAvatar) => void;
}) {
  return (
    <Tabs defaultValue="expression" className="space-y-3">
      <TabsList aria-label="Appearance category" className="flex w-full">
        <TabsTrigger value="expression">Face</TabsTrigger>
        <TabsTrigger value="shape">Shape</TabsTrigger>
        <TabsTrigger value="color">Color</TabsTrigger>
        <TabsTrigger value="motion">Motion</TabsTrigger>
      </TabsList>
      <TabsContent value="expression">
        <ToggleGroup
          type="single"
          aria-label="Expression"
          className="grid w-full grid-cols-4 gap-1 border-0 shadow-none"
          value={avatar.expression}
          onValueChange={(expression) => {
            if (expression)
              onChange({ ...avatar, expression: expression as BotAvatar["expression"] });
          }}
        >
          {AVATAR_EXPRESSIONS.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              aria-label={option.label}
              title={option.label}
              className={TILE_CLASS}
            >
              <BotIcon avatar={{ ...avatar, expression: option.id, motion: "still" }} size={32} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </TabsContent>
      <TabsContent value="shape">
        <ToggleGroup
          type="single"
          aria-label="Shape"
          className="grid w-full grid-cols-4 gap-1 border-0 shadow-none"
          value={avatar.shape}
          onValueChange={(shape) => {
            if (shape) onChange({ ...avatar, shape: shape as BotAvatar["shape"] });
          }}
        >
          {AVATAR_SHAPES.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              aria-label={option.label}
              title={option.label}
              className={TILE_CLASS}
            >
              <BotIcon avatar={{ ...avatar, shape: option.id, motion: "still" }} size={32} />
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </TabsContent>
      <TabsContent value="color">
        <fieldset aria-label="Color" className="flex flex-wrap items-center gap-2">
          {AVATAR_COLORS.map((color) => (
            <Tooltip key={color}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="size-7 rounded-full border-2 border-popover ring-offset-0 transition-shadow outline-none hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
                  style={{ background: color }}
                  aria-label={AVATAR_COLOR_LABELS[color]}
                  aria-pressed={avatar.color === color}
                  onClick={() => onChange({ ...avatar, color })}
                />
              </TooltipTrigger>
              <TooltipContent>{AVATAR_COLOR_LABELS[color]}</TooltipContent>
            </Tooltip>
          ))}
          <Tooltip>
            <TooltipTrigger asChild>
              <label className="relative size-7 cursor-pointer overflow-hidden rounded-full border border-dashed border-input hover:border-foreground focus-within:ring-2 focus-within:ring-ring">
                <span
                  aria-hidden="true"
                  className="absolute inset-1 rounded-full"
                  style={{ background: avatar.color }}
                />
                <input
                  type="color"
                  className="absolute inset-0 cursor-pointer opacity-0"
                  aria-label="Custom color"
                  value={avatar.color}
                  onChange={(event) => onChange({ ...avatar, color: event.target.value })}
                />
              </label>
            </TooltipTrigger>
            <TooltipContent>Custom color</TooltipContent>
          </Tooltip>
        </fieldset>
      </TabsContent>
      <TabsContent value="motion">
        <ToggleGroup
          type="single"
          aria-label="Motion"
          className="flex w-full flex-wrap"
          value={avatar.motion}
          onValueChange={(motion) => {
            if (motion) onChange({ ...avatar, motion: motion as BotAvatar["motion"] });
          }}
        >
          {AVATAR_MOTIONS.map((option) => (
            <ToggleGroupItem key={option.id} value={option.id} className="flex-1">
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </TabsContent>
    </Tabs>
  );
}
