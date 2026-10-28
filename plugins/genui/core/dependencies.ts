// What `Dependencies` shows: outdated packages (`npm outdated --json`, `pnpm
// outdated --format json`, `pip list --outdated --format=json`, or a list
// `{name, current, latest, wanted?, type?, severity?, note?}`) grouped by
// the semver bump to their latest version, and vulnerable packages
// (`npm audit --json` v2, `pnpm audit --json`'s advisories) by severity.
// `{outdated, audit}` holds one of each. Also the version arithmetic the
// renderer and the markdown share. Pure: no React, no DOM.
import type { Value } from "./types";

// ---------------------------------------------------------------------------
// Versions

export type Bump = "major" | "minor" | "patch" | "prerelease";

interface ParsedVersion {
  /** The release numbers: 1.2.3 → [1, 2, 3]; Python's 2.10 → [2, 10]. */
  readonly release: readonly number[];
  /** What follows the release, lowercased, without its separator: "beta.2", "rc1"; "" for a release. */
  readonly pre: string;
  /** A post-release (PEP 440 `.post1`), which sorts after its release. */
  readonly post: boolean;
}

/** `1.2.3`, `v1.2.3-beta.1+build`, `2.10`, `1.0rc1`, `2.0.0.post1`; null for ranges, tags and git URLs. */
export function parseVersion(text: string): ParsedVersion | null {
  const match = /^\s*[v=]?(\d+(?:\.\d+)*)(?:[-.]?([0-9a-z][0-9a-z.-]*))?(?:\+[0-9a-z.-]+)?\s*$/i.exec(text);
  if (match === null) return null;
  const rest = (match[2] ?? "").toLowerCase();
  return { release: match[1].split(".").map(Number), pre: /^post\d*/.test(rest) ? "" : rest, post: /^post\d*/.test(rest) };
}

/** Compares pre-release identifiers the semver way: numbers numerically, below words; fewer fields first. */
function comparePre(a: string, b: string): number {
  if (a === b) return 0;
  if (a === "") return 1;
  if (b === "") return -1;
  const x = a.split(/[.-]|(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)/);
  const y = b.split(/[.-]|(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d)/);
  for (let index = 0; index < Math.max(x.length, y.length); index++) {
    if (x[index] === undefined) return -1;
    if (y[index] === undefined) return 1;
    const m = /^\d+$/.test(x[index]);
    const n = /^\d+$/.test(y[index]);
    if (m && n && Number(x[index]) !== Number(y[index])) return Number(x[index]) - Number(y[index]);
    if (m !== n) return m ? -1 : 1;
    if (!m && x[index] !== y[index]) return x[index] < y[index] ? -1 : 1;
  }
  return 0;
}

/** Negative when `a` is older than `b`, 0 when equal; null when either isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x === null || y === null) return null;
  for (let index = 0; index < Math.max(x.release.length, y.release.length); index++) {
    const difference = (x.release[index] ?? 0) - (y.release[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return comparePre(x.pre, y.pre) || Number(x.post) - Number(y.post);
}

/**
 * The part of the version that changes from `from` to `to`: the first
 * release number that differs (the third and later are all "patch"), else
 * "prerelease" when only the pre-release or post-release differs; null when
 * they are equal or either isn't a version.
 */
export function versionBump(from: string, to: string): Bump | null {
  const x = parseVersion(from);
  const y = parseVersion(to);
  if (x === null || y === null) return null;
  for (let index = 0; index < Math.max(x.release.length, y.release.length); index++) {
    if ((x.release[index] ?? 0) !== (y.release[index] ?? 0)) return index === 0 ? "major" : index === 1 ? "minor" : "patch";
  }
  return x.pre !== y.pre || x.post !== y.post ? "prerelease" : null;
}

/**
 * `to` cut where it starts to differ from `from`, at a field boundary:
 * 4.17.15 → 4.18.1 is ["4.", "18.1"], 1.0.0-beta.1 → 1.0.0-beta.3 is
 * ["1.0.0-beta.", "3"]. Everything is "changed" when the first field differs.
 */
export function splitChange(from: string, to: string): readonly [same: string, changed: string] {
  const text = to.trim();
  const fields = (version: string) => version.match(/[0-9]+|[a-z]+|[^0-9a-z]+/gi) ?? [];
  const x = fields(from.trim());
  const y = fields(text);
  let same = 0;
  let length = 0;
  for (let index = 0; index < y.length; index++) {
    if (x[index] !== y[index]) return [text.slice(0, same), text.slice(same)];
    length += y[index].length;
    // Cut after a separator only, so a field is emphasised whole.
    if (!/[0-9a-z]/i.test(y[index])) same = length;
  }
  // `to` is `from` or a prefix of it: nothing in `to` changed.
  return [text, ""];
}

// ---------------------------------------------------------------------------
// The report

export type DependencyType = "prod" | "dev" | "optional" | "peer";

export type Severity = "critical" | "high" | "moderate" | "low" | "info";

export const SEVERITIES: readonly Severity[] = ["critical", "high", "moderate", "low", "info"];

export interface OutdatedPackage {
  readonly name: string;
  /** Installed version; null when the package is not installed. */
  readonly current: string | null;
  /** The newest version the manifest's range allows; null when the tool doesn't say. */
  readonly wanted: string | null;
  readonly latest: string | null;
  readonly type: DependencyType | null;
  /** current → latest; null when not installed or a version is not a plain version (a tag, git URL). */
  readonly bump: Bump | null;
  /** A 0.x minor bump: breaking under semver, so not part of "patch and minor". */
  readonly breaking: boolean;
  /** latest is older than current (a pre-release or `next` tag is installed). */
  readonly ahead: boolean;
  readonly deprecated: boolean;
  /** The workspace or package that depends on it, where the tool names several. */
  readonly dependent: string | null;
  readonly severity: Severity | null;
  readonly note: string | null;
  /** The package's page: its registry entry, or the list's own `url`. */
  readonly url: string | null;
}

export interface Advisory {
  readonly title: string;
  readonly url: string | null;
  readonly severity: Severity | null;
  /** The versions it affects. */
  readonly range: string | null;
}

export interface Fix {
  /** The package to change: the vulnerable one, or a direct dependency that pulls in a fixed version. */
  readonly name: string | null;
  readonly version: string | null;
  /** The fix needs a major update (npm's `isSemVerMajor`). */
  readonly major: boolean;
}

export interface VulnerablePackage {
  readonly name: string;
  readonly severity: Severity;
  /** The vulnerable versions. */
  readonly range: string | null;
  /** A dependency of the project's own; null when the report doesn't say (a hand-written list). */
  readonly direct: boolean | null;
  /** The vulnerable packages it is affected through (npm's string `via` entries). */
  readonly through: readonly string[];
  /** The project's dependencies that pull it in (pnpm's dependency paths). */
  readonly pulledInBy: readonly string[];
  readonly advisories: readonly Advisory[];
  /** null: no fix available. */
  readonly fix: Fix | null;
}

export type DependencySource = "npm" | "pnpm" | "pip" | "list";

export interface DependencyReport {
  /** The tool behind the outdated part; null when there is none. */
  readonly source: DependencySource | null;
  /** The tool behind the audit part ("npm audit", "pnpm audit"); null when there is none. */
  readonly auditSource: string | null;
  readonly outdated: readonly OutdatedPackage[];
  readonly vulnerable: readonly VulnerablePackage[];
  /** Vulnerabilities per severity: the audit's own totals where it gives them, else counted. */
  readonly severities: Readonly<Record<Severity, number>>;
  /** How many dependencies the audit looked at, where it says. */
  readonly scanned: number | null;
}

export type DependencyResult = { readonly ok: true; readonly report: DependencyReport } | { readonly ok: false; readonly error: string };

const SHAPE_HINT =
  "Dependencies needs npm outdated --json, pnpm outdated --format json, npm audit --json, pip list --outdated --format=json, or [{name, current, latest}]";

type Fields = Readonly<Record<string, Value | undefined>>;

function fieldsOf(value: Value | undefined): Fields | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if ("kind" in value && (value.kind === "node" || value.kind === "action" || value.kind === "binding")) return null;
  return value as Fields;
}

function str(value: Value | undefined): string | null {
  if (typeof value === "string") return value.trim() === "" ? null : value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

const TYPE_WORDS: Readonly<Record<string, DependencyType>> = {
  dependencies: "prod",
  dependency: "prod",
  prod: "prod",
  production: "prod",
  runtime: "prod",
  main: "prod",
  devdependencies: "dev",
  devdependency: "dev",
  dev: "dev",
  development: "dev",
  optionaldependencies: "optional",
  optional: "optional",
  peerdependencies: "peer",
  peer: "peer",
};

const SEVERITY_WORDS: Readonly<Record<string, Severity>> = {
  critical: "critical",
  high: "high",
  moderate: "moderate",
  medium: "moderate",
  low: "low",
  info: "info",
  informational: "info",
  none: "info",
};

export function severityOf(value: Value | undefined): Severity | null {
  const word = str(value)?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  return Object.hasOwn(SEVERITY_WORDS, word) ? SEVERITY_WORDS[word] : null;
}

function registryUrl(source: DependencySource, name: string): string | null {
  if (source === "pip") return `https://pypi.org/project/${encodeURIComponent(name)}/`;
  if (source === "list") return null;
  return `https://www.npmjs.com/package/${name.split("/").map(encodeURIComponent).join("/").replace(/^%40/, "@")}`;
}

function outdatedPackage(
  source: DependencySource,
  name: string,
  fields: {
    current: string | null;
    wanted: string | null;
    latest: string | null;
    type: Value | undefined;
    deprecated?: boolean;
    dependent?: string | null;
    severity?: Value;
    note?: string | null;
    url?: string | null;
  },
): OutdatedPackage {
  const { current, wanted, latest } = fields;
  const typeWord = str(fields.type)?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  const bump = current === null || latest === null ? null : versionBump(current, latest);
  const from = current === null ? null : parseVersion(current);
  const order = current === null || latest === null ? null : compareVersions(current, latest);
  return {
    name,
    current,
    wanted,
    latest,
    type: Object.hasOwn(TYPE_WORDS, typeWord) ? TYPE_WORDS[typeWord] : null,
    bump,
    breaking: bump === "minor" && from !== null && from.release[0] === 0,
    ahead: order !== null && order > 0,
    deprecated: fields.deprecated === true,
    dependent: fields.dependent ?? null,
    severity: severityOf(fields.severity),
    note: fields.note ?? null,
    url: fields.url ?? registryUrl(source, name),
  };
}

/** `npm outdated --json` (values may be lists, one per dependent workspace) or `pnpm outdated --format json`. */
function fromOutdatedObject(report: Fields): { source: DependencySource; outdated: OutdatedPackage[] } {
  const entries = Object.entries(report);
  const pnpm = entries.some(([, value]) => {
    const fields = fieldsOf(value);
    return fields !== null && (fields.dependencyType !== undefined || fields.isDeprecated !== undefined);
  });
  const source: DependencySource = pnpm ? "pnpm" : "npm";
  const outdated: OutdatedPackage[] = [];
  for (const [name, value] of entries) {
    const records = Array.isArray(value) ? value : [value];
    for (const record of records) {
      const fields = fieldsOf(record);
      if (fields === null) continue;
      const dependents = Array.isArray(fields.dependentPackages)
        ? fields.dependentPackages.flatMap((item) => str(fieldsOf(item)?.name) ?? [])
        : [];
      outdated.push(
        outdatedPackage(source, name, {
          // npm writes no `current` for a package that isn't installed (its table says MISSING).
          current: str(fields.current),
          wanted: str(fields.wanted),
          latest: str(fields.latest),
          type: fields.type ?? fields.dependencyType,
          deprecated: fields.isDeprecated === true,
          dependent: Array.isArray(value) && value.length > 1 ? str(fields.dependent) : dependents.length > 0 ? dependents.join(", ") : null,
        }),
      );
    }
  }
  return { source, outdated };
}

/** `npm audit --json` (auditReportVersion 2): `vulnerabilities` by package. */
function fromNpmAudit(report: Fields): AuditPart {
  const vulnerable: VulnerablePackage[] = [];
  for (const [key, value] of Object.entries(fieldsOf(report.vulnerabilities) ?? {})) {
    const fields = fieldsOf(value);
    const severity = severityOf(fields?.severity);
    if (fields === null || severity === null) continue;
    const via = Array.isArray(fields.via) ? fields.via : [];
    const advisories = via.flatMap((item): Advisory[] => {
      const advisory = fieldsOf(item);
      const title = advisory === null ? null : str(advisory.title);
      if (advisory === null || title === null) return [];
      return [{ title, url: webLink(advisory.url), severity: severityOf(advisory.severity), range: str(advisory.range) }];
    });
    const fixAvailable = fields.fixAvailable;
    const fixFields = fieldsOf(fixAvailable);
    const fix: Fix | null =
      fixFields !== null
        ? { name: str(fixFields.name), version: str(fixFields.version), major: fixFields.isSemVerMajor === true }
        : fixAvailable === true
          ? { name: null, version: null, major: false }
          : null;
    vulnerable.push({
      name: str(fields.name) ?? key,
      severity,
      range: str(fields.range),
      direct: fields.isDirect === true,
      through: via.flatMap((item) => (typeof item === "string" ? [item] : [])),
      pulledInBy: [],
      advisories,
      fix,
    });
  }
  const metadata = fieldsOf(report.metadata);
  return { vulnerable, severities: severityTotals(fieldsOf(metadata?.vulnerabilities)), scanned: scannedCount(metadata) };
}

/** `pnpm audit --json` (and npm 6's): `advisories` by id, one per advisory, grouped here by package. */
function fromAdvisories(report: Fields): AuditPart {
  const byName = new Map<string, { severity: Severity; ranges: Set<string>; direct: boolean; paths: Set<string>; advisories: Advisory[]; patched: Set<string> }>();
  for (const value of Object.values(fieldsOf(report.advisories) ?? {})) {
    const fields = fieldsOf(value);
    const name = fields === null ? null : str(fields.module_name);
    const severity = severityOf(fields?.severity);
    const title = fields === null ? null : str(fields.title);
    if (fields === null || name === null || severity === null || title === null) continue;
    const entry = byName.get(name) ?? { severity, ranges: new Set(), direct: false, paths: new Set(), advisories: [], patched: new Set() };
    if (SEVERITIES.indexOf(severity) < SEVERITIES.indexOf(entry.severity)) entry.severity = severity;
    const range = str(fields.vulnerable_versions);
    if (range !== null) entry.ranges.add(range);
    const patched = str(fields.patched_versions);
    if (patched !== null) entry.patched.add(patched);
    for (const finding of Array.isArray(fields.findings) ? fields.findings : []) {
      for (const path of Array.isArray(fieldsOf(finding)?.paths) ? (fieldsOf(finding)!.paths as readonly Value[]) : []) {
        const text = str(path);
        if (text === null) continue;
        // ".>hono" is the project's own dependency; ".>tsx>esbuild" comes through tsx.
        const hops = text.split(">").filter((hop) => hop !== "" && hop !== ".");
        if (hops.length <= 1) entry.direct = true;
        else entry.paths.add(hops.slice(0, -1).join(" › "));
      }
    }
    entry.advisories.push({ title, url: webLink(fields.url), severity, range });
    byName.set(name, entry);
  }
  const vulnerable = [...byName].map(([name, entry]): VulnerablePackage => {
    // "<0.0.0" is the advisory format's "no patched version".
    const patched = [...entry.patched].filter((range) => range !== "<0.0.0");
    return {
      name,
      severity: entry.severity,
      range: entry.ranges.size === 0 ? null : [...entry.ranges].join(" || "),
      direct: entry.direct,
      through: [],
      pulledInBy: [...entry.paths],
      advisories: entry.advisories,
      fix: patched.length === 0 ? null : { name, version: patched.length === 1 ? patched[0] : null, major: false },
    };
  });
  const metadata = fieldsOf(report.metadata);
  return { vulnerable, severities: severityTotals(fieldsOf(metadata?.vulnerabilities)), scanned: scannedCount(metadata) };
}

function webLink(value: Value | undefined): string | null {
  const text = str(value);
  return text !== null && /^https?:\/\/\S+$/i.test(text) ? text : null;
}

function severityTotals(fields: Fields | null): Record<Severity, number> | null {
  if (fields === null) return null;
  const totals = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const severity of SEVERITIES) {
    const count = fields[severity];
    if (typeof count === "number" && Number.isFinite(count) && count >= 0) totals[severity] = count;
  }
  return totals;
}

function scannedCount(metadata: Fields | null): number | null {
  const dependencies = metadata?.dependencies;
  if (typeof dependencies === "number") return dependencies + (typeof metadata!.devDependencies === "number" ? metadata!.devDependencies : 0);
  const total = fieldsOf(dependencies)?.total ?? metadata?.totalDependencies;
  return typeof total === "number" && Number.isFinite(total) ? total : null;
}

function isAudit(fields: Fields): boolean {
  return (fieldsOf(fields.vulnerabilities) !== null && (fields.auditReportVersion !== undefined || fields.metadata !== undefined)) || fieldsOf(fields.advisories) !== null;
}

/** A list item: pip's `{name, version, latest_version}` or `{name, current, latest, wanted?, type?, severity?, note?, url?}`. */
function fromList(values: readonly Value[]): OutdatedPart {
  const pip = values.some((value) => fieldsOf(value)?.latest_version !== undefined);
  const source: DependencySource = pip ? "pip" : "list";
  const outdated: OutdatedPackage[] = [];
  for (const value of values) {
    const fields = fieldsOf(value);
    const name = fields === null ? null : (str(fields.name) ?? str(fields.package));
    if (fields === null || name === null) continue;
    outdated.push(
      outdatedPackage(source, name, {
        current: str(fields.current) ?? str(fields.version) ?? str(fields.installed),
        wanted: str(fields.wanted),
        latest: str(fields.latest) ?? str(fields.latest_version),
        type: fields.type,
        severity: fields.severity ?? undefined,
        note: str(fields.note),
        url: webLink(fields.url),
      }),
    );
  }
  return { source, outdated };
}

interface OutdatedPart {
  readonly source: DependencySource;
  readonly outdated: readonly OutdatedPackage[];
}

/** An audit's vulnerable packages and its own totals. */
interface AuditPart {
  readonly vulnerable: readonly VulnerablePackage[];
  readonly severities: Record<Severity, number> | null;
  readonly scanned: number | null;
}

/** An outdated report or list, or why it can't be read. */
function readOutdated(part: Value | undefined): OutdatedPart | string {
  if (Array.isArray(part)) {
    const list = fromList(part);
    return list.outdated.length === 0 && part.length > 0 ? "Dependencies items need a name" : list;
  }
  const object = fieldsOf(part);
  return object === null ? SHAPE_HINT : fromOutdatedObject(object);
}

/** The report `value` describes, or why it can't be read. */
export function readDependencies(value: Value | undefined): DependencyResult {
  const fields = fieldsOf(value);
  const combined = fields !== null && (fields.outdated !== undefined || fields.audit !== undefined) && !isPackageMap(fields);
  const auditFields = combined ? fieldsOf(fields.audit) : fields !== null && isAudit(fields) ? fields : null;
  if (combined && fields.audit !== undefined && (auditFields === null || !isAudit(auditFields))) {
    return { ok: false, error: "Dependencies' audit needs npm audit --json or pnpm audit --json" };
  }
  const outdated = combined
    ? fields.outdated === undefined
      ? null
      : readOutdated(fields.outdated)
    : auditFields === null
      ? readOutdated(value)
      : null;
  if (typeof outdated === "string") return { ok: false, error: outdated };
  const npmAudit = auditFields !== null && fieldsOf(auditFields.vulnerabilities) !== null;
  const audit = auditFields === null ? null : npmAudit ? fromNpmAudit(auditFields) : fromAdvisories(auditFields);
  const packages = outdated?.outdated ?? [];
  // Without an audit, a list's own severities are its vulnerabilities, fixed by its latest version.
  const listed = packages.flatMap((item): VulnerablePackage[] =>
    item.severity === null
      ? []
      : [
          {
            name: item.name,
            severity: item.severity,
            range: null,
            direct: null,
            through: [],
            pulledInBy: [],
            advisories: item.note === null ? [] : [{ title: item.note, url: null, severity: item.severity, range: null }],
            fix: item.latest === null || item.ahead ? null : { name: item.name, version: item.latest, major: item.bump === "major" || item.breaking },
          },
        ],
  );
  const vulnerable = audit?.vulnerable ?? listed;
  const counted = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const item of vulnerable) counted[item.severity]++;
  return {
    ok: true,
    report: {
      source: outdated?.source ?? null,
      auditSource: audit === null ? null : npmAudit ? "npm audit" : "pnpm audit",
      outdated: packages,
      vulnerable: [...vulnerable].sort(
        (a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || Number(b.direct === true) - Number(a.direct === true) || a.name.localeCompare(b.name),
      ),
      severities: audit?.severities ?? counted,
      scanned: audit?.scanned ?? null,
    },
  };
}

/** npm outdated's map could hold packages named "outdated" or "audit": a map's values all look like packages. */
function isPackageMap(fields: Fields): boolean {
  return Object.values(fields).every((value) => {
    const record = fieldsOf(Array.isArray(value) ? value[0] : value);
    return record !== null && (record.latest !== undefined || record.wanted !== undefined);
  });
}

// ---------------------------------------------------------------------------
// Grouping and the words the renderer and the markdown share

export type OutdatedGroupKey = Bump | "missing" | "other";

export const GROUP_ORDER: readonly OutdatedGroupKey[] = ["major", "minor", "patch", "prerelease", "missing", "other"];

export const GROUP_LABEL: Record<OutdatedGroupKey, string> = {
  major: "Major",
  minor: "Minor",
  patch: "Patch",
  prerelease: "Pre-release",
  missing: "Not installed",
  other: "Other",
};

export interface OutdatedGroup {
  readonly key: OutdatedGroupKey;
  readonly packages: readonly OutdatedPackage[];
}

/** Packages by bump in GROUP_ORDER, each group by name; empty groups left out. */
export function groupOutdated(packages: readonly OutdatedPackage[]): OutdatedGroup[] {
  const groups = new Map<OutdatedGroupKey, OutdatedPackage[]>(GROUP_ORDER.map((key) => [key, []]));
  for (const item of packages) groups.get(item.current === null ? "missing" : (item.bump ?? "other"))!.push(item);
  return GROUP_ORDER.flatMap((key) => {
    const list = groups.get(key)!;
    return list.length === 0 ? [] : [{ key, packages: [...list].sort((a, b) => a.name.localeCompare(b.name)) }];
  });
}

/** The highest version short of a major (or 0.x minor) update: latest when that is a minor or patch bump, else wanted when it is. */
export function safeTarget(item: OutdatedPackage): string | null {
  if (item.current === null) return null;
  if (item.latest !== null && !item.ahead && (item.bump === "minor" || item.bump === "patch") && !item.breaking) return item.latest;
  if (item.wanted === null || item.wanted === item.current) return null;
  const bump = versionBump(item.current, item.wanted);
  const order = compareVersions(item.current, item.wanted);
  return (bump === "minor" || bump === "patch") && order !== null && order < 0 && !(bump === "minor" && parseVersion(item.current)?.release[0] === 0)
    ? item.wanted
    : null;
}

/** What "Update patch and minor" sends; null when nothing qualifies. */
export function updateMessage(report: DependencyReport): string | null {
  const targets = report.outdated.flatMap((item) => {
    const target = safeTarget(item);
    return target === null ? [] : [`${item.name} ${item.current} → ${target}`];
  });
  if (targets.length === 0) return null;
  const shown = targets.slice(0, 25);
  const more = targets.length > shown.length ? `, and ${targets.length - shown.length} more` : "";
  return `Update these dependencies to their latest patch and minor versions, then run the tests: ${shown.join(", ")}${more}. Leave the major updates for now.`;
}

/** "4 critical, 9 high, 4 moderate, 3 low": severest first, zero counts left out. */
export function severityText(severities: Readonly<Record<Severity, number>>): string {
  return SEVERITIES.filter((severity) => severities[severity] > 0)
    .map((severity) => `${severities[severity]} ${severity}`)
    .join(", ");
}

/** What "Fix vulnerabilities" sends; null when there are none. */
export function fixMessage(report: DependencyReport): string | null {
  const total = SEVERITIES.reduce((sum, severity) => sum + report.severities[severity], 0);
  if (total === 0) return null;
  const tool = report.auditSource ?? "reported";
  const majors = report.vulnerable.filter((item) => item.fix?.major === true);
  const unfixable = report.vulnerable.filter((item) => item.fix === null);
  const listed = report.auditSource === null ? report.outdated.filter((item) => item.severity !== null).map((item) => item.name) : [];
  return [
    `Fix the ${tool} vulnerabilities (${severityText(report.severities)})${listed.length > 0 ? ` in ${listed.join(", ")}` : ""}.`,
    majors.length > 0
      ? `These fixes need a major update, so check their breaking changes: ${majors.map((item) => `${item.fix!.name ?? item.name}${item.fix!.version === null ? "" : ` ${item.fix!.version}`}`).filter((text, index, all) => all.indexOf(text) === index).join(", ")}.`
      : "",
    unfixable.length > 0 ? `No fix is available yet for ${unfixable.map((item) => item.name).join(", ")}.` : "",
  ]
    .filter((part) => part !== "")
    .join(" ");
}
