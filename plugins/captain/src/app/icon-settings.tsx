/**
 * Captain icons: the glyph or picture each Captain shows in the sidebar, in
 * Captain's settings. An icon name must be one of bb's built-in icons: bb
 * gives plugins no list of them, so the row draws the typed name and reads
 * back which icon bb drew. A picture, SVG included, is re-encoded here as the
 * small PNG Captain stores; see `icon-image.ts`. Every edit saves at once.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useLayoutEffect, useRef, useState, type ChangeEvent, type SyntheticEvent } from "react";
import {
  DEFAULT_ICON_GLYPH,
  normalizeIconName,
  type CaptainIcon,
  type IconChoice,
} from "../contract/icon.ts";
import { captainContract } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { iconImage } from "./icon-image.ts";
import { cn } from "./lib/utils.ts";

const NO_INPUT = {};
/** A phone or touch screen gets 44px targets, Apple's minimum. */
const TOUCH_ROW = "max-md:min-h-11 pointer-coarse:min-h-11";
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";
/** bb's own glyph for a question, drawn for a name bb has no icon by. */
const UNKNOWN_ICON = "CircleQuestion";

export function CaptainIconSettings() {
  const list = useRpcQuery({ contract: captainContract, method: "captainIcons", input: NO_INPUT });
  if (list.data === undefined) {
    return (
      <div className="flex flex-col gap-2" data-bb-plugin="captain" data-bb-plugin-scope-captain="">
        {list.error === null ? (
          <div className="h-12 animate-pulse rounded-md bg-muted" />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm wrap-anywhere text-destructive">
              Captains not loaded: {list.error.message}
            </p>
            <Button
              variant="outline"
              size="sm"
              className={TOUCH_ROW}
              onClick={() => void list.refetch()}
            >
              Retry
            </Button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-bb-plugin="captain" data-bb-plugin-scope-captain="">
      <p className="text-sm text-muted-foreground">
        Type a name from bb's icon set, such as Star, Target or Brain; a question mark means bb has
        no icon by that name. Or upload a picture; <code>bb captain icon</code> sets names only.
      </p>
      {list.data.captains.length === 0 ? (
        <p className="text-sm text-muted-foreground">No live Captains yet.</p>
      ) : (
        <ul className="flex flex-col rounded-md border">
          {list.data.captains.map((captain) => (
            <CaptainIconRow key={captain.threadId} {...captain} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CaptainIconRow({
  threadId,
  name,
  icon,
}: {
  threadId: string;
  name: string;
  icon: CaptainIcon;
}) {
  const save = useRpcMutation({
    contract: captainContract,
    method: "setIcon",
    optimistic({ captainId, icon: choice }, cache) {
      cache.update("captainIcons", NO_INPUT, (current) => ({
        captains: current.captains.map((entry) =>
          entry.threadId === captainId ? { ...entry, icon: choice ?? { kind: "default" } } : entry,
        ),
      }));
    },
  });
  // What the user is typing; null shows the stored name, so a change made
  // elsewhere, such as `bb captain icon`, shows here and is never written back.
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (icon.kind === "icon" ? icon.name : "");
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLSpanElement>(null);
  // An upload can save only while its row is mounted and no newer edit has started.
  const edits = useRef(0);
  useLayoutEffect(
    () => () => {
      edits.current += 1;
    },
    [],
  );
  const write = (choice: IconChoice) => {
    edits.current += 1;
    setProblem(null);
    setNote(null);
    const submitted = draft;
    // The draft clears only once the save lands, so a failed save keeps what was typed.
    save
      .mutate({ captainId: threadId, icon: choice })
      .then(() => setDraft((current) => (current === submitted ? null : current)))
      .catch(() => {});
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const iconName = normalizeIconName(value);
    if (iconName === null) {
      setProblem("Type an icon name such as Star.");
      return;
    }
    // bb marks the icon it drew with its name; the question mark means it has none by this one.
    const drawn = preview.current?.querySelector("[data-icon]")?.getAttribute("data-icon");
    if (typeof drawn === "string" && drawn !== iconName) {
      setProblem(`Unknown icon: bb has no icon named ${iconName}.`);
      return;
    }
    write({ kind: "icon", name: iconName });
    if (typeof drawn !== "string")
      setNote(`${iconName} was saved without a check against bb's icon set.`);
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    edits.current += 1;
    const edit = edits.current;
    let src: string;
    try {
      src = await iconImage(file);
    } catch (error) {
      if (edits.current === edit) setProblem((error as Error).message);
      return;
    }
    if (edits.current === edit) write({ kind: "image", src });
  };
  const error = problem ?? (save.error === null ? null : `Not saved: ${save.error.message}`);
  const typedName = normalizeIconName(value);

  return (
    <li className="flex flex-col gap-1 border-t px-3 py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-48 items-center gap-2" title={name}>
          <StoredIcon icon={icon} />
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{iconLabel(icon)}</span>
        </span>
        <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={submit}>
          <span className="flex min-w-0 items-center gap-2">
            {/* The typed name as bb draws it, read back on save. */}
            <span ref={preview} className="flex size-4 shrink-0" aria-hidden>
              {value.trim() === "" ? null : (
                <Icon
                  name={typedName ?? UNKNOWN_ICON}
                  fallback={UNKNOWN_ICON}
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
              )}
            </span>
            <Input
              value={value}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Star"
              aria-label={`Icon name for ${name}`}
              className={cn("h-8 w-36 min-w-0", TOUCH_ROW)}
            />
            <Button type="submit" variant="outline" size="sm" className={TOUCH_ROW}>
              Set icon
            </Button>
          </span>
          <span className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={TOUCH_ROW}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="FolderOpen" aria-hidden />
              Upload image
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              className="hidden"
              aria-label={`Image for ${name}`}
              onChange={(event) => void upload(event)}
            />
            {icon.kind === "default" ? null : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={TOUCH_ROW}
                onClick={() => write(null)}
              >
                Use default
              </Button>
            )}
          </span>
        </form>
      </div>
      {error === null ? null : <p className="text-xs wrap-anywhere text-destructive">{error}</p>}
      {note === null || error !== null ? null : (
        <p className="text-xs wrap-anywhere text-muted-foreground">{note}</p>
      )}
    </li>
  );
}

function iconLabel(icon: CaptainIcon): string {
  if (icon.kind === "icon") return icon.name;
  return icon.kind;
}

/** The row's stored icon at settings size; a name bb lacks draws the default glyph, as in the sidebar. */
function StoredIcon({ icon }: { icon: CaptainIcon }) {
  if (icon.kind === "image") {
    return (
      <img src={icon.src} alt="" aria-hidden className="size-4 shrink-0 rounded-sm object-cover" />
    );
  }
  return (
    <Icon
      name={icon.kind === "icon" ? icon.name : DEFAULT_ICON_GLYPH}
      fallback={DEFAULT_ICON_GLYPH}
      className="size-4 shrink-0"
      aria-hidden
    />
  );
}
