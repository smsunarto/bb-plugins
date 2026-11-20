/**
 * Captain icons: the glyph or picture each Captain shows in the sidebar, in
 * Captain's settings. An icon name is one of bb's built-in icons (bb ships a
 * fixed set and exposes no list of it, so the row previews the typed name); an
 * uploaded picture is
 * scaled down here so the stored image stays small. Every edit saves at once.
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
  normalizeIconName,
  type CaptainIcon,
  type IconChoice,
} from "../contract/icon.ts";
import { captainContract } from "../contract/rpc.ts";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { cn } from "./lib/utils.ts";

const NO_INPUT = {};
/** Uploaded pictures are drawn at this many pixels a side: twice a sidebar row's 2x size. */
const IMAGE_SIDE = 96;
/** A phone or touch screen gets 44px targets, Apple's minimum. */
const TOUCH_ROW = "max-md:min-h-11 pointer-coarse:min-h-11";
/** bb's own glyph for an icon name it does not have. */
const UNKNOWN_ICON = "CircleQuestion";
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

export function CaptainIconSettings() {
  const list = useRpcQuery({ contract: captainContract, method: "captainIcons", input: NO_INPUT });
  if (list.data === undefined) {
    return (
      <div className="flex flex-col gap-2" data-bb-plugin="captain" data-bb-plugin-scope-captain="">
        {list.error === null ? (
          <div className="h-12 animate-pulse rounded-md bg-muted" />
        ) : (
          <p className="text-sm text-destructive">Captains not loaded: {list.error.message}</p>
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
        <ul className="@container flex flex-col rounded-md border">
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
  const [typed, setTyped] = useState(icon.kind === "icon" ? icon.name : "");
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const write = (choice: IconChoice) => {
    setProblem(null);
    save.mutate({ captainId: threadId, icon: choice }).catch(() => {});
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const iconName = normalizeIconName(typed);
    if (iconName === null) {
      setProblem("Type an icon name such as Star.");
      return;
    }
    setTyped(iconName);
    write({ kind: "icon", name: iconName });
  };
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) return;
    try {
      write({ kind: "image", src: await iconImage(file) });
      setTyped("");
    } catch (error) {
      setProblem((error as Error).message);
    }
  };
  const error = problem ?? (save.error === null ? null : `Not saved: ${save.error.message}`);

  return (
    <li className="flex flex-col gap-1 border-t px-3 py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="flex min-w-0 flex-1 basis-40 items-center gap-2">
          <CaptainIconGlyph icon={icon} className="size-4 shrink-0" />
          <span className="truncate text-sm font-medium">{name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {icon.kind === "default" ? "default" : icon.kind === "icon" ? icon.name : "image"}
          </span>
        </span>
        <form className="flex min-w-0 flex-wrap items-center gap-2" onSubmit={submit}>
          {/* What the typed name draws; bb's question mark when it has no icon by that name. */}
          {typed.trim() === "" ? (
            <span className="size-4 shrink-0" aria-hidden />
          ) : (
            <Icon
              name={normalizeIconName(typed) ?? UNKNOWN_ICON}
              fallback={UNKNOWN_ICON}
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden
            />
          )}
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="Star"
            aria-label={`Icon name for ${name}`}
            className={cn("h-8 w-36 min-w-0", TOUCH_ROW)}
          />
          <Button type="submit" variant="outline" size="sm" className={TOUCH_ROW}>
            Set icon
          </Button>
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
              onClick={() => {
                setTyped("");
                write(null);
              }}
            >
              Use default
            </Button>
          )}
        </form>
      </div>
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
    </li>
  );
}

/** A Captain's icon as the sidebar draws it. */
export function CaptainIconGlyph({ icon, className }: { icon: CaptainIcon; className?: string }) {
  if (icon.kind === "image") {
    return (
      <img src={icon.src} alt="" aria-hidden className={cn("rounded-sm object-cover", className)} />
    );
  }
  return (
    <Icon
      name={icon.kind === "icon" ? icon.name : DEFAULT_ICON_GLYPH}
      fallback={DEFAULT_ICON_GLYPH}
      className={className}
      aria-hidden
    />
  );
}

/**
 * The uploaded file as a data URL Captain accepts. An SVG is kept as drawn;
 * any other picture is cropped square and scaled to `IMAGE_SIDE` as a PNG.
 */
async function iconImage(file: File): Promise<string> {
  if (file.type === "image/svg+xml") {
    if (file.size > ICON_IMAGE_MAX_BYTES) throw new Error("That SVG is over 128 KB.");
    return readDataUrl(file);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file is not an image this browser can read.");
  }
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_SIDE;
  canvas.height = IMAGE_SIDE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This browser cannot scale the image.");
  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    IMAGE_SIDE,
    IMAGE_SIDE,
  );
  bitmap.close();
  return canvas.toDataURL("image/png");
}

async function readDataUrl(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${file.type};base64,${btoa(binary)}`;
}
