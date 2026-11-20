/**
 * Captain icons: the glyph or picture each Captain shows in the sidebar, in
 * Captain's settings. An icon name must be one of bb's built-in icons: bb
 * gives plugins no list of them, so the row draws the typed name and reads
 * back which icon bb drew. A picture, SVG included, is drawn onto a 96 px
 * canvas here and stored as a small raster. Every edit saves at once.
 */
import {
  experimental_Icon as Icon,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
} from "@get-bb/plugin-sdk/app";
import { useRef, useState, type ChangeEvent, type SyntheticEvent } from "react";
import {
  DEFAULT_ICON_GLYPH,
  ICON_IMAGE_MAX_BYTES,
  ICON_IMAGE_SIDE,
  normalizeIconName,
  type CaptainIcon,
  type IconChoice,
} from "../contract/icon.ts";
import { captainContract } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
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
            <p className="text-sm text-destructive">Captains not loaded: {list.error.message}</p>
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
        no icon by that name. Or upload a picture. Also <code>bb captain icon</code>.
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
  const write = (choice: IconChoice) => {
    setProblem(null);
    setNote(null);
    setDraft(null);
    save.mutate({ captainId: threadId, icon: choice }).catch(() => {});
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
    try {
      write({ kind: "image", src: await iconImage(file) });
    } catch (error) {
      setProblem((error as Error).message);
    }
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
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
      {note === null || error !== null ? null : (
        <p className="text-xs text-muted-foreground">{note}</p>
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

/**
 * The uploaded file as a data URL Captain accepts: cropped to its centre
 * square, drawn at `ICON_IMAGE_SIDE` px, and encoded as the smallest of PNG,
 * WebP and JPEG that fits `ICON_IMAGE_MAX_BYTES`. An SVG is drawn the same
 * way, so only a raster is stored.
 */
async function iconImage(file: File): Promise<string> {
  const picture = await loadPicture(file);
  const width = picture.width || ICON_IMAGE_SIDE;
  const height = picture.height || ICON_IMAGE_SIDE;
  const side = Math.min(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = ICON_IMAGE_SIDE;
  canvas.height = ICON_IMAGE_SIDE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser cannot scale the image.");
  context.drawImage(
    picture.source,
    (width - side) / 2,
    (height - side) / 2,
    side,
    side,
    0,
    0,
    ICON_IMAGE_SIDE,
    ICON_IMAGE_SIDE,
  );
  picture.release();
  for (const [type, quality] of [
    ["image/png", undefined],
    ["image/webp", 0.9],
    ["image/webp", 0.75],
    ["image/jpeg", 0.8],
  ] as const) {
    const url = canvas.toDataURL(type, quality);
    // A browser that can't encode a type returns PNG; the length check still holds.
    if (url.startsWith(`data:${type};`) && dataUrlBytes(url) <= ICON_IMAGE_MAX_BYTES) return url;
  }
  throw new Error("That picture is too detailed to fit 16 KB at 96 px; try a simpler one.");
}

type Picture = {
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
};

/** Decode a raster with `createImageBitmap`, and an SVG through an `<img>`, which can draw one. */
async function loadPicture(file: File): Promise<Picture> {
  if (file.type !== "image/svg+xml") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      throw new Error("That file is not an image this browser can read.");
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.src = url;
  try {
    await image.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error("That SVG could not be drawn.");
  }
  return {
    source: image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

/** A base64 data URL's decoded size in bytes. */
function dataUrlBytes(url: string): number {
  const body = url.slice(url.indexOf(",") + 1);
  return Math.floor((body.length * 3) / 4) - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
}
