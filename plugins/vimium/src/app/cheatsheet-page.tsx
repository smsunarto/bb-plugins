import { Fragment, type ReactElement } from "react";
import { CHEATSHEET, type CheatsheetEntry, type CheatsheetSection } from "./cheatsheet.ts";

function Key({ label }: { label: string }): ReactElement {
  return (
    <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground shadow-[0_1px_0] shadow-border">
      {label}
    </kbd>
  );
}

function Keys({ entry }: { entry: CheatsheetEntry }): ReactElement {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {entry.keys.map((key, index) => (
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

function Section({ section }: { section: CheatsheetSection }): ReactElement {
  return (
    <section className="break-inside-avoid rounded-lg border border-border bg-card p-4">
      <h2 className="text-sm font-semibold text-foreground">{section.title}</h2>
      {section.note && <p className="mt-1 text-xs text-muted-foreground">{section.note}</p>}
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
        {section.entries.map((entry) => (
          <Fragment key={entry.action}>
            <dt>
              <Keys entry={entry} />
            </dt>
            <dd className="text-sm text-foreground">{entry.action}</dd>
          </Fragment>
        ))}
      </dl>
    </section>
  );
}

export function CheatsheetPage(): ReactElement {
  return (
    <div className="@container h-full overflow-y-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Single keys work anywhere outside a text field. Inside one, every key is typing; press
          Escape to leave the composer first.
        </p>
        <div className="columns-1 gap-4 space-y-4 @2xl:columns-2 @5xl:columns-3">
          {CHEATSHEET.map((section) => (
            <Section key={section.title} section={section} />
          ))}
        </div>
      </div>
    </div>
  );
}
