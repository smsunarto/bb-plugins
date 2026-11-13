import { Fragment, useEffect, useState, type ReactElement } from "react";
import { experimental_usePluginId, useSdk } from "@get-bb/plugin-sdk/app";
import {
  CHEATSHEET,
  boundShortcut,
  keybindingPlatform,
  shortcutLabel,
  type CheatsheetEntry,
  type CheatsheetSection,
  type KeybindingOverride,
} from "./cheatsheet.ts";

const PLATFORM = keybindingPlatform(navigator.platform);

/** The user's saved keyboard bindings, or null until they load. */
function useKeybindingOverrides(): readonly KeybindingOverride[] | null {
  const sdk = useSdk();
  const [overrides, setOverrides] = useState<readonly KeybindingOverride[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    sdk.system
      .config({ signal: controller.signal })
      .then((config) => setOverrides(config.keybindingOverrides))
      .catch(() => {
        if (!controller.signal.aborted) setOverrides([]);
      });
    return () => controller.abort();
  }, [sdk]);
  return overrides;
}

interface ResolvedEntry {
  /** Null while the bindings load; empty when unbound. */
  readonly keys: readonly string[] | null;
  readonly oneOf?: true;
  readonly action: string;
}

function Key({ label }: { label: string }): ReactElement {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground shadow-[0_1px_0] shadow-border">
      {label}
    </kbd>
  );
}

function Keys({ entry }: { entry: ResolvedEntry }): ReactElement {
  if (entry.keys === null)
    return <span aria-hidden className="block h-6 w-6 animate-pulse rounded bg-muted" />;
  if (entry.keys.length === 0)
    return <span className="text-xs text-muted-foreground">Unbound</span>;
  const keys = entry.keys;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {keys.map((key, index) => (
        <Fragment key={key}>
          {index > 0 && !entry.oneOf && <span className="text-xs text-muted-foreground">then</span>}
          {key.split("+").map((part, partIndex) => (
            <Fragment key={part}>
              {partIndex > 0 && <span className="text-xs text-muted-foreground">+</span>}
              <Key label={part} />
            </Fragment>
          ))}
        </Fragment>
      ))}
    </span>
  );
}

function Section({
  section,
  resolve,
}: {
  section: CheatsheetSection;
  resolve: (entry: CheatsheetEntry) => ResolvedEntry;
}): ReactElement {
  return (
    <section className="mb-4 break-inside-avoid rounded-lg border border-border bg-card p-4 last:mb-0">
      <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
      {section.note && <p className="mt-1 text-xs text-muted-foreground">{section.note}</p>}
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
        {section.entries.map((entry) => (
          <Fragment key={entry.action}>
            <dt>
              <Keys entry={resolve(entry)} />
            </dt>
            <dd className="text-sm text-foreground">{entry.action}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

export function CheatsheetPage(): ReactElement {
  const pluginId = experimental_usePluginId();
  const overrides = useKeybindingOverrides();
  const resolve = (entry: CheatsheetEntry): ResolvedEntry => {
    if (!("command" in entry)) return entry;
    if (overrides === null) return { action: entry.action, keys: null };
    const shortcut = boundShortcut(`plugin:${pluginId}/${entry.command.id}`, overrides, PLATFORM);
    return {
      action: entry.action,
      keys: shortcut === null ? [] : [shortcutLabel(shortcut, PLATFORM === "mac")],
    };
  };
  return (
    <div className="@container h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          Single keys work anywhere outside a text field. Inside one, every key is typing; press
          Escape to leave the composer first.
        </p>
        <div className="columns-1 gap-4 @2xl:columns-2 @5xl:columns-3">
          {CHEATSHEET.map((section) => (
            <Section key={section.title} section={section} resolve={resolve} />
          ))}
        </div>
      </div>
    </div>
  );
}
