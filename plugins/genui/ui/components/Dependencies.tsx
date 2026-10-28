// A dependency report as a reviewer reads it: what is vulnerable, how badly
// and whether a fix exists (and whether it is a major update); what is
// outdated, grouped by how big the update is, with the part of the version
// that changes emphasised. Updating or fixing is a message the user sends;
// nothing runs from here.
import { useContext, useId, useMemo, useState, type ReactNode } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  fixMessage,
  GROUP_LABEL,
  groupOutdated,
  readDependencies,
  SEVERITIES,
  splitChange,
  updateMessage,
  versionBump,
  type DependencyReport,
  type OutdatedGroup,
  type OutdatedGroupKey,
  type OutdatedPackage,
  type Severity,
  type VulnerablePackage,
} from "../../core/dependencies";
import type { Action } from "../../core/types";
import { CardDepthContext, NodeKeyContext } from "../runtime";
import { formatNumber, TONE_DOT, TONE_PILL, TONE_TEXT, type Props, type Tone } from "../values";
import { ErrorLine } from "./display";
import { Button, ButtonGroup, FOCUS_RING } from "./inputs";
import { CHART_DRAW_MS, FADE, RISE, SMOOTH_HEIGHT_CLASS, useEntrance, useSmoothHeight, type Entrance } from "./motion";

/** Rows a group or the vulnerable list shows before "N more". */
const ROW_PAGE = 15;

const GROW_X: Entrance = { keyframes: [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], duration: CHART_DRAW_MS };

const TEXT_BUTTON = cn(
  "w-fit shrink-0 cursor-pointer rounded-sm text-xs leading-5 text-muted-foreground transition-colors duration-150 hover:text-foreground",
  FOCUS_RING,
);

/** As npm-check-updates colours them: major red, minor blue, patch green. */
const GROUP_TONE: Record<OutdatedGroupKey, Tone> = {
  major: "bad",
  minor: "info",
  patch: "good",
  prerelease: "warn",
  missing: "warn",
  other: "neutral",
};

const GROUP_HINT: Record<OutdatedGroupKey, string> = {
  major: "may break",
  minor: "new features",
  patch: "fixes",
  prerelease: "pre-release tag only",
  missing: "in the manifest, not installed",
  other: "not plain versions",
};

const GROUP_FILL: Record<OutdatedGroupKey, string> = {
  major: "bg-destructive",
  minor: "bg-[var(--color-timeline-accent,var(--primary))]",
  patch: "bg-success",
  prerelease: "bg-warning",
  missing: "bg-warning/50",
  other: "bg-muted-foreground/35",
};

const SEVERITY_TONE: Record<Severity, Tone> = { critical: "bad", high: "bad", moderate: "warn", low: "neutral", info: "neutral" };

const SEVERITY_FILL: Record<Severity, string> = {
  critical: "bg-destructive",
  high: "bg-destructive/55",
  moderate: "bg-warning",
  low: "bg-muted-foreground/45",
  info: "bg-muted-foreground/25",
};

const TYPE_LABEL = { prod: null, dev: "dev", optional: "optional", peer: "peer" } as const;

const SOURCE_LABEL = { npm: "npm outdated", pnpm: "pnpm outdated", pip: "pip list --outdated", list: null } as const;

// ---------------------------------------------------------------------------
// Pieces

function Chevron({ open }: { open: boolean }) {
  return (
    <Icon
      name="ChevronRight"
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:text-foreground motion-reduce:transition-none",
        open && "rotate-90",
      )}
    />
  );
}

function Chip({ children, tone = "neutral", title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return (
    <span title={title} className={cn("shrink-0 rounded-full px-1.5 text-[10.5px] font-medium leading-4", TONE_PILL[tone])}>
      {children}
    </span>
  );
}

function SeverityPill({ severity }: { severity: Severity }) {
  return (
    <span
      className={cn(
        "inline-flex w-[68px] shrink-0 justify-center rounded-full px-1.5 text-[10.5px] font-semibold uppercase leading-4 tracking-[0.03em]",
        severity === "critical" ? "bg-destructive text-destructive-foreground" : TONE_PILL[SEVERITY_TONE[severity]],
      )}
    >
      {severity}
    </span>
  );
}

/** A package name, linking to its registry page where there is one. */
function PackageName({ name, url }: { name: string; url: string | null }) {
  const label = <span className="min-w-0 truncate font-mono text-[12.5px] leading-5 text-foreground">{name}</span>;
  if (url === null) return <span className="flex min-w-0" title={name}>{label}</span>;
  return (
    <UrlLink href={url} title={`Open ${name}'s page`} className={cn("flex min-w-0 rounded-sm no-underline hover:underline hover:underline-offset-2", FOCUS_RING)}>
      {label}
    </UrlLink>
  );
}

/** `to` with the part that changed from `from` in the bump's colour. */
function Version({ from, to, tone, title }: { from: string | null; to: string; tone: Tone; title?: string }) {
  const [same, changed] = from === null ? [to, ""] : splitChange(from, to);
  return (
    <span title={title} className="font-mono text-[12px] tabular-nums text-muted-foreground">
      {same}
      {changed === "" ? null : <span className={cn("font-semibold", TONE_TEXT[tone] || "text-foreground")}>{changed}</span>}
    </span>
  );
}

function Arrow() {
  return (
    <span aria-hidden className="text-muted-foreground/60">
      →
    </span>
  );
}

/** A strip of counts as a bar with its legend; parts with no count are left out of the bar. */
function Strip({ label, parts }: { label: string; parts: readonly { key: string; count: number; fill: string; ink: string; word: string }[] }) {
  const grow = useEntrance<HTMLDivElement>(GROW_X);
  const shown = parts.filter((part) => part.count > 0);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div ref={grow} role="img" aria-label={label} className="flex h-1.5 w-full origin-left gap-[2px] overflow-hidden rounded-full bg-muted">
        {shown.map((part) => (
          <div key={part.key} className={cn("h-full min-w-[3px]", part.fill)} style={{ flex: `${part.count} 1 0` }} />
        ))}
      </div>
      <p aria-hidden className="m-0 flex flex-wrap gap-x-3.5 gap-y-0.5 text-xs leading-5 text-muted-foreground">
        {shown.map((part) => (
          <span key={part.key} className="flex items-center gap-1.5 tabular-nums">
            <span className={cn("size-2 rounded-full", part.fill)} />
            <span className={cn("font-medium", part.ink || "text-foreground")}>{formatNumber(part.count)}</span>
            {part.word}
          </span>
        ))}
      </p>
    </div>
  );
}

function MoreButton({ rest, noun, onClick }: { rest: number; noun: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cn(TEXT_BUTTON, "pl-[22px]")}>
      Show {formatNumber(rest)} more {noun}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Vulnerabilities

function fixText(item: VulnerablePackage): { text: string; tone: Tone } {
  if (item.fix === null) return { text: "no fix yet", tone: "bad" };
  const target = item.fix.name === null ? "" : `${item.fix.name}${item.fix.version === null ? "" : ` ${item.fix.version}`}`;
  if (item.fix.major) return { text: `fix: ${target} (major)`, tone: "warn" };
  return { text: target === "" ? "fix available" : `fix: ${target}`, tone: "good" };
}

function VulnerableRow({ item }: { item: VulnerablePackage }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const id = useId();
  const [open, setOpen] = useState(false);
  const { outer, inner } = useSmoothHeight<HTMLDivElement, HTMLDivElement>();
  const fix = fixText(item);
  const first = item.advisories[0] ?? null;
  const reach =
    item.direct === true ? "direct" : item.pulledInBy.length > 0 ? `via ${item.pulledInBy.join(", ")}` : item.direct === false ? "transitive" : null;
  const through = item.through.length > 0 ? `through ${item.through.join(", ")}` : null;
  const expandable = item.advisories.length > 0;
  const header = (
    <>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="flex min-w-0 flex-1 basis-[220px] items-center gap-2">
          {expandable ? <Chevron open={open} /> : <span aria-hidden className="w-3.5 shrink-0" />}
          <SeverityPill severity={item.severity} />
          <span className="shrink-0 font-mono text-[12.5px] leading-5 text-foreground">{item.name}</span>
          {item.range === null ? null : (
            <span title={item.range} className="min-w-0 truncate font-mono text-[11px] leading-5 text-muted-foreground">
              {item.range}
            </span>
          )}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-xs leading-5">
          {reach === null ? null : <span className="text-muted-foreground">{reach}</span>}
          <span className={cn("font-medium", TONE_TEXT[fix.tone])}>{fix.text}</span>
        </span>
      </span>
      {(first === null || open) && through === null ? null : (
        <span className="block truncate pl-[22px] text-xs leading-5 text-muted-foreground">
          {[
            first === null || open ? null : `${first.title}${item.advisories.length > 1 ? ` · ${formatNumber(item.advisories.length - 1)} more` : ""}`,
            through,
          ]
            .filter((part) => part !== null)
            .join(" · ")}
        </span>
      )}
    </>
  );
  return (
    <li ref={rise} className="min-w-0">
      <div ref={outer} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
        <div ref={inner} className="flex min-w-0 flex-col">
          {expandable ? (
            <button
              type="button"
              id={`${id}-row`}
              aria-expanded={open}
              aria-controls={`${id}-advisories`}
              onClick={() => setOpen((value) => !value)}
              className={cn("group flex w-full min-w-0 cursor-pointer flex-col rounded-md py-1 text-left", FOCUS_RING)}
            >
              {header}
            </button>
          ) : (
            <div className="flex min-w-0 flex-col py-1">{header}</div>
          )}
          {open ? (
            <ul id={`${id}-advisories`} aria-labelledby={`${id}-row`} className="m-0 flex min-w-0 list-none flex-col gap-1 pb-1.5 pl-[22px] pt-0.5">
              {item.advisories.map((advisory, index) => (
                <li key={index} className="flex min-w-0 items-start gap-2 text-xs leading-5">
                  <span aria-hidden className={cn("mt-[7px] size-1.5 shrink-0 rounded-full", TONE_DOT[SEVERITY_TONE[advisory.severity ?? item.severity]])} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    {advisory.url === null ? (
                      <span className="text-foreground [overflow-wrap:anywhere]">{advisory.title}</span>
                    ) : (
                      <UrlLink href={advisory.url} className={cn("w-fit rounded-sm text-foreground no-underline hover:underline hover:underline-offset-2 [overflow-wrap:anywhere]", FOCUS_RING)}>
                        {advisory.title}
                        <Icon name="ExternalLink" aria-hidden className="ml-1 inline size-3 align-[-1px] text-muted-foreground" />
                      </UrlLink>
                    )}
                    <span className="text-muted-foreground">
                      {advisory.severity ?? item.severity}
                      {advisory.range === null ? "" : ` · `}
                      {advisory.range === null ? null : <span className="font-mono text-[11px]">{advisory.range}</span>}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function Vulnerabilities({ report }: { report: DependencyReport }) {
  const [shown, setShown] = useState(ROW_PAGE);
  const total = SEVERITIES.reduce((sum, severity) => sum + report.severities[severity], 0);
  const rest = report.vulnerable.length - shown;
  const label = `${formatNumber(total)} ${total === 1 ? "vulnerability" : "vulnerabilities"}`;
  return (
    <section aria-label="Vulnerabilities" className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h4 className="m-0 shrink-0 text-[13px] font-semibold leading-5 text-foreground">{label}</h4>
        <span className="min-w-0 truncate text-xs leading-5 text-muted-foreground">
          {report.auditSource}
          {report.scanned === null ? "" : ` · ${formatNumber(report.scanned)} dependencies scanned`}
        </span>
      </div>
      <Strip
        label={SEVERITIES.filter((severity) => report.severities[severity] > 0).map((severity) => `${report.severities[severity]} ${severity}`).join(", ")}
        parts={SEVERITIES.map((severity) => ({
          key: severity,
          count: report.severities[severity],
          fill: SEVERITY_FILL[severity],
          ink: TONE_TEXT[SEVERITY_TONE[severity]],
          word: severity,
        }))}
      />
      {report.vulnerable.length === 0 ? null : (
        <ul className="m-0 flex min-w-0 list-none flex-col p-0">
          {report.vulnerable.slice(0, shown).map((item, index) => (
            <VulnerableRow key={index} item={item} />
          ))}
        </ul>
      )}
      {rest > 0 ? <MoreButton rest={rest} noun={rest === 1 ? "package" : "packages"} onClick={() => setShown((count) => count + ROW_PAGE * 4)} /> : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Outdated

function OutdatedRow({ item, tone }: { item: OutdatedPackage; tone: Tone }) {
  const rise = useEntrance<HTMLLIElement>(RISE);
  const type = item.type === null ? null : TYPE_LABEL[item.type];
  // wanted earns its place only between current and latest.
  const wanted = item.wanted !== null && item.wanted !== item.current && item.wanted !== item.latest ? item.wanted : null;
  return (
    <li ref={rise} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-1 pl-[22px]">
      <span className="flex min-w-0 items-center gap-1.5">
        <PackageName name={item.name} url={item.url} />
        {type === null ? null : <Chip>{type}</Chip>}
        {item.dependent === null ? null : <Chip title="Depended on by">{item.dependent}</Chip>}
        {item.deprecated ? <Chip tone="warn">deprecated</Chip> : null}
        {item.breaking ? (
          <Chip tone="warn" title="Before 1.0, a minor update may break: semver gives 0.x versions no stability promise">
            0.x: may break
          </Chip>
        ) : null}
        {item.severity === null ? null : <Chip tone={SEVERITY_TONE[item.severity]}>{item.severity}</Chip>}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs leading-5">
        {item.current === null ? (
          <>
            <span className="font-medium text-warning-text">not installed</span>
            {item.wanted === null ? null : (
              <span className="text-muted-foreground">
                wants <span className="font-mono text-[12px] tabular-nums">{item.wanted}</span>
              </span>
            )}
            {item.latest === null || item.latest === item.wanted ? null : (
              <span className="text-muted-foreground">
                latest <span className="font-mono text-[12px] tabular-nums">{item.latest}</span>
              </span>
            )}
          </>
        ) : (
          <>
            <span className="sr-only">from</span>
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{item.current}</span>
            {wanted === null ? null : (
              <>
                <Arrow />
                <span className="sr-only">wanted</span>
                <span className="border-b border-dotted border-muted-foreground/60">
                  <Version from={item.current} to={wanted} tone={GROUP_TONE[versionBump(item.current, wanted) ?? "other"]} title="Wanted: the newest version your manifest's range allows" />
                </span>
              </>
            )}
            {item.latest === null ? null : (
              <>
                <Arrow />
                <span className="sr-only">latest</span>
                <Version
                  from={wanted ?? item.current}
                  to={item.latest}
                  tone={item.ahead ? "neutral" : wanted === null ? tone : GROUP_TONE[versionBump(wanted, item.latest) ?? "other"]}
                  title="Latest"
                />
              </>
            )}
          </>
        )}
      </span>
      {item.ahead ? <span className="w-full text-xs leading-5 text-muted-foreground">latest is older than what is installed (a pre-release or other tag)</span> : null}
      {item.note === null ? null : <span className="w-full text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">{item.note}</span>}
    </li>
  );
}

function Group({ group, defaultOpen }: { group: OutdatedGroup; defaultOpen: boolean }) {
  const id = useId();
  const [open, setOpen] = useState(defaultOpen);
  const [shown, setShown] = useState(ROW_PAGE);
  const { outer, inner } = useSmoothHeight<HTMLElement, HTMLDivElement>();
  const tone = GROUP_TONE[group.key];
  const rest = group.packages.length - shown;
  const dev = group.packages.filter((item) => item.type === "dev").length;
  return (
    <section ref={outer} aria-label={`${GROUP_LABEL[group.key]} updates`} className={cn("min-w-0", SMOOTH_HEIGHT_CLASS)}>
      <div ref={inner} className="flex min-w-0 flex-col">
        <button
          type="button"
          id={`${id}-group`}
          aria-expanded={open}
          aria-controls={`${id}-packages`}
          onClick={() => setOpen((value) => !value)}
          className={cn("group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md py-1 text-left text-xs leading-5", FOCUS_RING)}
        >
          <Chevron open={open} />
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", GROUP_FILL[group.key])} />
          <span className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-foreground">{GROUP_LABEL[group.key]}</span>
          <span className="tabular-nums text-muted-foreground">{formatNumber(group.packages.length)}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            · {GROUP_HINT[group.key]}
            {dev > 0 && dev < group.packages.length ? ` · ${formatNumber(dev)} dev` : ""}
          </span>
        </button>
        {open ? (
          <div id={`${id}-packages`} role="region" aria-labelledby={`${id}-group`} className="flex min-w-0 flex-col">
            <ul className="m-0 flex min-w-0 list-none flex-col divide-y divide-border/50 p-0">
              {group.packages.slice(0, shown).map((item, index) => (
                <OutdatedRow key={index} item={item} tone={tone} />
              ))}
            </ul>
            {rest > 0 ? <MoreButton rest={rest} noun={rest === 1 ? "package" : "packages"} onClick={() => setShown((count) => count + ROW_PAGE * 4)} /> : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Outdated({ report }: { report: DependencyReport }) {
  const groups = useMemo(() => groupOutdated(report.outdated), [report.outdated]);
  const source = report.source === null ? null : SOURCE_LABEL[report.source];
  const dev = report.outdated.filter((item) => item.type === "dev").length;
  const typed = report.outdated.some((item) => item.type !== null);
  const count = report.outdated.length;
  // Long reports open with their two most pressing groups; short ones open whole.
  const openAll = count <= 30;
  return (
    <section aria-label="Outdated packages" className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h4 className="m-0 shrink-0 text-[13px] font-semibold leading-5 text-foreground">
          {formatNumber(count)} outdated {count === 1 ? "package" : "packages"}
        </h4>
        <span className="min-w-0 truncate text-xs leading-5 text-muted-foreground">
          {[source, typed ? `${formatNumber(count - dev)} prod · ${formatNumber(dev)} dev` : null].filter((part) => part !== null).join(" · ")}
        </span>
      </div>
      <Strip
        label={groups.map((group) => `${group.packages.length} ${GROUP_LABEL[group.key].toLowerCase()}`).join(", ")}
        parts={groups.map((group) => ({
          key: group.key,
          count: group.packages.length,
          fill: GROUP_FILL[group.key],
          ink: TONE_TEXT[GROUP_TONE[group.key]],
          word: GROUP_LABEL[group.key].toLowerCase(),
        }))}
      />
      <p aria-hidden className="m-0 flex items-center justify-end gap-1.5 text-[11px] leading-4 text-muted-foreground/80">
        current <Arrow /> <span className="border-b border-dotted border-muted-foreground/60">wanted</span> <Arrow /> latest
      </p>
      <div className="flex min-w-0 flex-col gap-1">
        {groups.map((group, index) => (
          <Group key={group.key} group={group} defaultOpen={openAll || index < 2} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------

function sendButton(label: string, text: string, primary: boolean) {
  const action: Action = { kind: "action", type: "send", text };
  const props = { label, action: [action], ...(primary ? { variant: "primary" } : {}) };
  return { key: label, props, element: <Button props={props} /> };
}

export function Dependencies({ props }: { props: Props }) {
  const depth = useContext(CardDepthContext);
  const question = `${useContext(NodeKeyContext)}/actions`;
  const fade = useEntrance<HTMLDivElement>(FADE);
  const result = useMemo(() => readDependencies(props.report), [props.report]);
  if (!result.ok) return <ErrorLine message={result.error} />;
  const report = result.report;
  const vulnerable = SEVERITIES.some((severity) => report.severities[severity] > 0);
  const audited = report.auditSource !== null;
  const update = updateMessage(report);
  const fix = fixMessage(report);
  const buttons = [
    ...(fix === null ? [] : [sendButton("Fix vulnerabilities", fix, true)]),
    ...(update === null ? [] : [sendButton("Update patch and minor", update, fix === null)]),
  ];
  const empty = report.outdated.length === 0 && !vulnerable;
  const body = (
    <div ref={fade} className="flex min-w-0 flex-col gap-4">
      {vulnerable || audited ? (
        vulnerable ? (
          <Vulnerabilities report={report} />
        ) : (
          <p className="m-0 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
            <Icon name="CircleCheck" aria-hidden className="size-3.5 text-success" />
            {report.auditSource} found no vulnerabilities{report.scanned === null ? "" : ` in ${formatNumber(report.scanned)} dependencies`}.
          </p>
        )
      ) : null}
      {report.outdated.length > 0 ? (
        <Outdated report={report} />
      ) : report.source !== null && !empty ? (
        <p className="m-0 text-xs leading-5 text-muted-foreground">Every dependency is on its latest version.</p>
      ) : null}
      {empty && !audited ? (
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="m-0 text-[15px] font-semibold leading-6 text-foreground">Dependencies</h3>
          <p className="m-0 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
            <Icon name="CircleCheck" aria-hidden className="size-3.5 text-success" />
            Every dependency is on its latest version.
          </p>
        </div>
      ) : null}
      {buttons.length === 0 ? null : <ButtonGroup buttons={buttons} question={question} />}
    </div>
  );
  if (depth > 0) return <div className="min-w-0 text-sm text-foreground">{body}</div>;
  return (
    <CardDepthContext value={1}>
      <section aria-label="Dependencies" className="min-w-0 rounded-xl border border-border bg-background p-4 text-sm text-foreground sm:px-5">
        {body}
      </section>
    </CardDepthContext>
  );
}
