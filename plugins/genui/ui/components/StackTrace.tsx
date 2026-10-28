// An error as a debugger would open it: the type and message large, the code
// around the first frame of the app's own code with the failing line marked,
// the frames with dependency and runtime frames folded, and each cause (or an
// AggregateError's errors) as its own section. Reads any language's trace
// (core/stack-trace.ts); the code comes through runtime.readText.
import { useContext, useMemo, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { LANGUAGE_NAMES, frameRows, memberPlaces, readTrace, relationLabel, sourcePath, type Trace, type TraceFrame, type TraceSection } from "../../core/stack-trace";
import { commonDirectory } from "../../core/test-results";
import { CardDepthContext, useUiRuntime } from "../runtime";
import { formatNumber, optionalText, type Props } from "../values";
import { CodeExcerpt, OpenFileButton, ReportFrame, ReportPathsContext, TEXT_BUTTON, useFileText, useShownPath, useWorkspaceRoot } from "./codeHealthKit";
import { ErrorLine } from "./display";
import { FOCUS_RING } from "./inputs";
import { FADE, RISE, useEntrance } from "./motion";
import { ICON_BUTTON } from "./projectKit";

/** Sections shown before "Show N more errors". */
const SECTION_PAGE = 6;
/** Frame rows shown per section before "Show N more frames". */
const FRAME_PAGE = 30;
/** Message lines shown before "Show all N lines". */
const MESSAGE_LINES = 12;

// ---------------------------------------------------------------------------
// Code at a frame

/** The code around a frame: its file read and the line marked; Python's own source line where the file can't be read. */
function FrameCode({ frame }: { frame: TraceFrame }) {
  const path = sourcePath(frame);
  const guessed = frame.location !== null && !frame.location.linkable;
  const file = useFileText(path);
  if (path === null || frame.location === null) return null;
  // A JVM frame's file is a guess at the source layout: say nothing when it isn't there.
  if (guessed && (file === null || !file.ok)) return null;
  const column = frame.location.column;
  return (
    <CodeExcerpt
      path={path}
      file={file}
      mark={{ start: frame.location.line, end: frame.location.line, column: column === null ? null : { start: column, end: null } }}
      tone="bad"
      snippet={frame.source}
    />
  );
}

// ---------------------------------------------------------------------------
// Frames

function FrameRow({ frame, selected, first, onSelect }: { frame: TraceFrame; selected: boolean; first: boolean; onSelect: (() => void) | null }) {
  const shown = useShownPath();
  const location = frame.location;
  // A runtime frame names its place without a file: `node:net:2021:16`, `<anonymous>`, `[native code]`, `Native Method`.
  const where =
    location !== null
      ? `${shown(location.path)}:${location.line}${location.column === null ? "" : `:${location.column}`}`
      : frame.fn === null
        ? null
        : (/\(([^()]+)\)$/.exec(frame.text)?.[1] ?? /@(.+)$/.exec(frame.text)?.[1] ?? null);
  const name = frame.fn ?? (location === null ? frame.text.replace(/^at\s+/, "") : null);
  const body = (
    <>
      <span
        className={cn(
          "min-w-0 font-mono text-[12px] leading-5 [overflow-wrap:anywhere]",
          frame.app ? "font-medium text-foreground" : "text-muted-foreground",
          name === null && "italic text-muted-foreground",
        )}
      >
        {name ?? "anonymous"}
      </span>
      {where === null ? null : (
        <span className="min-w-0 font-mono text-[11px] leading-5 text-muted-foreground [overflow-wrap:anywhere]" title={location?.path}>
          {where}
        </span>
      )}
    </>
  );
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-1 border-l-2 pl-2 pr-0.5",
        selected ? "border-destructive bg-destructive/[0.06]" : first ? "border-destructive/40" : "border-transparent",
      )}
    >
      {onSelect === null ? (
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 py-0.5">{body}</span>
      ) : (
        <button
          type="button"
          aria-pressed={selected}
          aria-label={`Show the code of ${name ?? "anonymous"} at ${where}`}
          onClick={onSelect}
          className={cn("flex min-w-0 flex-1 cursor-pointer flex-wrap items-baseline gap-x-2 rounded-sm py-0.5 text-left hover:bg-state-hover", FOCUS_RING)}
        >
          {body}
        </button>
      )}
      {location === null || !location.linkable ? null : <OpenFileButton path={location.path} line={location.line} />}
    </li>
  );
}

function Frames({
  section,
  selected,
  onSelect,
  appIndex,
  omittedNote,
}: {
  section: TraceSection;
  selected: number;
  onSelect: (index: number) => void;
  appIndex: number;
  omittedNote: string;
}) {
  const [unfolded, setUnfolded] = useState<ReadonlySet<number>>(new Set());
  const [all, setAll] = useState(false);
  const rows = useMemo(() => frameRows(section.frames, unfolded), [section.frames, unfolded]);
  const shown = all ? rows : rows.slice(0, FRAME_PAGE);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <ol aria-label="Frames" className="m-0 flex min-w-0 list-none flex-col p-0">
        {shown.map((row) =>
          row.type === "fold" ? (
            <li key={`fold-${row.start}`} className="border-l-2 border-transparent pl-2">
              <button
                type="button"
                onClick={() => setUnfolded((previous) => new Set(previous).add(row.start))}
                className={cn(TEXT_BUTTON, "font-mono text-[11.5px]")}
              >
                … {formatNumber(row.count)} library frames
              </button>
            </li>
          ) : (
            <FrameRow
              key={row.index}
              frame={section.frames[row.index]}
              selected={row.index === selected}
              first={row.index === appIndex}
              onSelect={sourcePath(section.frames[row.index]) === null ? null : () => onSelect(row.index)}
            />
          ),
        )}
        {section.omitted > 0 && (all || rows.length <= FRAME_PAGE) ? (
          <li className="border-l-2 border-transparent pl-2 font-mono text-[11.5px] leading-5 text-muted-foreground">
            … {formatNumber(section.omitted)} more {section.omitted === 1 ? "frame" : "frames"} {omittedNote}
          </li>
        ) : null}
      </ol>
      {rows.length > FRAME_PAGE ? (
        <button type="button" onClick={() => setAll((value) => !value)} className={cn(TEXT_BUTTON, "pl-2.5")}>
          {all ? "Show fewer frames" : `Show ${formatNumber(rows.length - FRAME_PAGE)} more frames`}
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// A section: one error

function Message({ text, large }: { text: string; large: boolean }) {
  const [all, setAll] = useState(false);
  const lines = text.split("\n");
  const cut = !all && lines.length > MESSAGE_LINES;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <p
        className={cn(
          "m-0 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]",
          large ? "text-[15px] font-medium leading-6 tracking-[-0.01em]" : "text-[13px] leading-5",
        )}
      >
        {cut ? lines.slice(0, MESSAGE_LINES).join("\n") : text}
      </p>
      {lines.length > MESSAGE_LINES ? (
        <button type="button" onClick={() => setAll((value) => !value)} className={TEXT_BUTTON}>
          {all ? "Show fewer lines" : `Show all ${formatNumber(lines.length)} lines`}
        </button>
      ) : null}
    </div>
  );
}

function Section({
  section,
  top,
  label,
  omittedNote,
}: {
  section: TraceSection;
  top: boolean;
  label: string;
  omittedNote: string;
}) {
  const rise = useEntrance<HTMLElement>(RISE);
  const appIndex = section.frames.findIndex((f) => f.app);
  const codeIndex = section.frames.findIndex((f) => f.app && sourcePath(f) !== null);
  const [selected, setSelected] = useState(codeIndex);
  const frame = section.frames[selected] as TraceFrame | undefined;
  const heading = section.type === "" ? (section.message === "" ? "Error" : null) : section.type;
  return (
    <section
      ref={rise}
      aria-label={`${label ? `${label}: ` : ""}${heading ?? ""}${section.message === "" ? "" : ` ${section.message.split("\n", 1)[0]}`}`}
      className={cn("flex min-w-0 flex-col gap-2.5", section.depth > 0 && "border-l border-border pl-3")}
      style={section.depth > 1 ? { marginLeft: `${(section.depth - 1) * 12}px` } : undefined}
    >
      {label === "" ? null : (
        <p className="m-0 flex items-center gap-1.5 text-xs font-medium leading-5 text-muted-foreground">
          <Icon name="CornerDownRight" aria-hidden className="size-3.5" />
          {label}
        </p>
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        {heading === null ? null : (
          <h3
            className={cn(
              "m-0 font-mono font-semibold text-destructive [overflow-wrap:anywhere]",
              top ? "text-[13px] leading-5" : "text-[12.5px] leading-5",
            )}
          >
            {heading}
          </h3>
        )}
        {section.message === "" ? null : <Message text={section.message} large={top} />}
        {section.fields.length === 0 ? null : (
          <dl className="m-0 mt-1 flex min-w-0 flex-wrap gap-1">
            {section.fields.map(([key, value], index) => (
              <div key={index} className="flex min-w-0 items-baseline gap-1 rounded-md bg-muted px-1.5 font-mono text-[11px] leading-5">
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="m-0 min-w-0 text-foreground [overflow-wrap:anywhere]">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      {frame === undefined ? null : <FrameCode key={selected} frame={frame} />}
      {section.frames.length === 0 ? null : (
        <Frames section={section} selected={selected} onSelect={setSelected} appIndex={appIndex} omittedNote={omittedNote} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Header

function Header({ trace, title }: { trace: Trace; title: string | null }) {
  const fade = useEntrance<HTMLDivElement>(FADE);
  const { run } = useUiRuntime();
  const causes = trace.sections.filter((s) => s.relation === "cause" || s.relation === "context").length;
  const members = trace.sections.filter((s) => s.relation === "member").length;
  const facts = [
    LANGUAGE_NAMES[trace.language],
    ...trace.notes,
    trace.reversed ? "most recent call first" : "",
    causes > 0 ? `${formatNumber(causes)} ${causes === 1 ? "cause" : "causes"}` : "",
    members > 0 ? `${formatNumber(members)} ${members === 1 ? "error" : "errors"} inside` : "",
  ].filter((fact) => fact !== "");
  return (
    <div ref={fade} className="flex min-w-0 items-start gap-2">
      <Icon name="Bug" aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col">
        {title === null ? null : <h2 className="m-0 text-[13px] font-semibold leading-5 text-foreground [overflow-wrap:anywhere]">{title}</h2>}
        <p className="m-0 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{facts.join(" · ") || "Stack trace"}</p>
      </div>
      <button
        type="button"
        title="Copy the trace"
        aria-label="Copy the trace"
        onClick={() => void run([{ kind: "action", type: "copy", text: trace.raw }])}
        className={ICON_BUTTON}
      >
        <Icon name="Copy" className="size-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function StackTrace({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const result = useMemo(() => readTrace(props.trace), [props.trace]);
  const title = optionalText(props.title);
  const [more, setMore] = useState(false);
  const trace = result.ok ? result.trace : null;
  const { common, absolute } = useMemo(() => {
    const paths = trace === null ? [] : trace.sections.flatMap((s) => s.frames.flatMap((f) => (f.location?.linkable ? [f.location.path] : [])));
    // Paths read relative to what the app's own frames share; a dependency's keep their full path.
    const own = trace === null ? [] : trace.sections.flatMap((s) => s.frames.flatMap((f) => (f.app && f.location?.linkable ? [f.location.path] : [])));
    return {
      common: commonDirectory(own.map((path) => (path.startsWith("file://") ? path.slice(7) : path))),
      absolute: paths.some((path) => path.startsWith("/") || path.startsWith("file://")),
    };
  }, [trace]);
  const root = useWorkspaceRoot(absolute);
  const paths = useMemo(() => ({ root, common }), [root, common]);
  const places = useMemo(() => (trace === null ? [] : memberPlaces(trace.sections)), [trace]);

  if (trace === null) return <ErrorLine message={result.ok ? "" : result.error} />;
  const sections = more ? trace.sections : trace.sections.slice(0, SECTION_PAGE);
  const rest = trace.sections.length - sections.length;
  const omittedNote = trace.language === "java" ? "as in the error above" : "as in the cause";
  const body = (
    <ReportPathsContext value={paths}>
      <div className="flex min-w-0 flex-col gap-4">
        <Header trace={trace} title={title} />
        {sections.map((section, index) => (
          <Section
            key={index}
            section={section}
            top={index === 0}
            label={relationLabel(section.relation, places[index] ?? null)}
            omittedNote={omittedNote}
          />
        ))}
        {rest > 0 ? (
          <button type="button" onClick={() => setMore(true)} className={TEXT_BUTTON}>
            Show {formatNumber(rest)} more {rest === 1 ? "error" : "errors"}
          </button>
        ) : null}
      </div>
    </ReportPathsContext>
  );
  return (
    <ReportFrame depth={depth} label={title ?? "Stack trace"}>
      {depth > 0 ? body : <CardDepthContext value={1}>{body}</CardDepthContext>}
    </ReportFrame>
  );
}
