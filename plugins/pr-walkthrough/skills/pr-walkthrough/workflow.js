export const meta = {
  name: "pr-walkthrough",
  description:
    "Generate a PR walkthrough: collect context, plan semantic review groups, author sections in parallel, build the static guide, repair failures, and browser-validate",
  phases: [
    { title: "Context", detail: "Collect PR metadata, diff, and existing review evidence" },
    { title: "Plan", detail: "Group changed files into ordered semantic review groups" },
    { title: "Author", detail: "One agent per group writes its section MDX with a Guide block" },
    { title: "Assemble", detail: "Write index.mdx, scaffold the site, compile, and validate" },
    { title: "Repair", detail: "Fix compiler and validation failures, then rebuild" },
    { title: "Validate", detail: "Serve the static export and run the browser checklist" },
  ],
};

// args:
//   skillDir (required) — absolute path to the pr-walkthrough skill directory
//                         (contains SKILL.md, scripts/, assets/site-template/, workflow.js).
//   request      (optional) — user constraints: base branch override, PR selection, emphasis.
//   buildAttempt (optional) — increment after a returned build failure when resuming.
const skillDir = args && args.skillDir;
if (!skillDir) {
  throw new Error(
    "args.skillDir is required: absolute path to the pr-walkthrough skill directory",
  );
}
const request = (args && args.request) || "";
const buildAttempt =
  args && Number.isInteger(args.buildAttempt) && args.buildAttempt >= 0
    ? args.buildAttempt
    : 0;
const requestNote = request
  ? `\n\nUser constraints for this run (respect them):\n${request}\n`
  : "";

const contract = `Read ${skillDir}/SKILL.md before doing anything else. It is the authoritative contract for this task. Work in the current workspace repository root. All walkthrough state lives under .pr-walkthrough/ in the workspace.`;

// ---------------------------------------------------------------------------
// Phase: Context — one agent establishes PR context and shared evidence files.
// ---------------------------------------------------------------------------
phase("Context");
log("Collecting PR context and diff");

const context = await agent(
  `${contract}

Perform SKILL.md step 1 ("Establish pull-request context") and the evidence-gathering half of step 2 exactly:
- Identify the repository root, current branch, and comparison base (GitHub PR base when one exists, otherwise the remote default branch).
- Write the canonical patch to .pr-walkthrough/changes.patch with the exact git command in SKILL.md.
- Collect PR title, body, URL, state, and every existing review/issue comment when a PR exists.
- Download useful PR images or exports into .pr-walkthrough/assets/. Do not hotlink.
- Write .pr-walkthrough/context.json containing: baseRef, headRef, headSha, title, prUrl (null when absent), and the full changed-file list with per-file status and add/delete counts.
- Write .pr-walkthrough/evidence.md containing existing review comments (verbatim, attributed, with URLs), pointers to PR-changed specs, and notes on which evidence kinds exist. Later agents read this file instead of re-querying GitHub.
- Do not fabricate evidence. Record honestly which evidence kinds were unavailable.${requestNote}
Return the structured summary. In "files", mark a file generated=true only for conservative generated artifacts (lockfiles, snapshots, generated metadata, binaries) per SKILL.md step 3.`,
  {
    label: "collect-context",
    phase: "Context",
    schema: {
      type: "object",
      required: ["baseRef", "headRef", "headSha", "title", "files"],
      properties: {
        baseRef: { type: "string" },
        headRef: { type: "string" },
        headSha: { type: "string" },
        title: { type: "string" },
        prUrl: { type: "string", nullable: true },
        hasComments: { type: "boolean" },
        hasChangedSpecs: { type: "boolean" },
        files: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["path", "status"],
            properties: {
              path: { type: "string" },
              status: { type: "string" },
              additions: { type: "integer" },
              deletions: { type: "integer" },
              generated: { type: "boolean" },
            },
          },
        },
      },
    },
  },
);

if (!context) {
  throw new Error("Context agent failed; cannot continue without PR context");
}
const changedPaths = context.files.map((file) => file.path);
log(`Context ready: ${changedPaths.length} changed files, base ${context.baseRef}`);

// ---------------------------------------------------------------------------
// Phase: Plan — one agent proposes semantic groups; the script enforces the
// exactly-once file-coverage invariant and retries with the violation list.
// ---------------------------------------------------------------------------
phase("Plan");

const planSchema = {
  type: "object",
  required: ["groups"],
  properties: {
    groups: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        required: ["id", "title", "objective", "files"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          objective: { type: "string" },
          rationale: { type: "string" },
          files: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
  },
};

function planViolations(groups) {
  const problems = [];
  const seen = {};
  const known = {};
  for (const path of changedPaths) known[path] = true;
  const ids = {};
  for (const group of groups) {
    if (ids[group.id]) problems.push(`duplicate group id: ${group.id}`);
    ids[group.id] = true;
    for (const path of group.files) {
      if (!known[path]) problems.push(`unknown file in group ${group.id}: ${path}`);
      if (seen[path]) problems.push(`file assigned twice: ${path}`);
      seen[path] = true;
    }
  }
  for (const path of changedPaths) {
    if (!seen[path]) problems.push(`changed file missing from every group: ${path}`);
  }
  return problems;
}

const planPrompt = `${contract}

Perform the planning half of SKILL.md steps 2 and 3. Read .pr-walkthrough/context.json, .pr-walkthrough/evidence.md, and .pr-walkthrough/changes.patch, and read the checkout at the PR head as architecture truth. Group files by implementation purpose, not path or file type. Scale group count to the change per SKILL.md step 2 (do not inflate small pull requests). Order groups in the intended review order: foundations before behavior before integration.

Assign every changed file below to exactly one group — generated artifacts too (they stay in their owning group; the section author classifies them). Use unique lowercase kebab-case group ids.

Changed files:
${changedPaths.join("\n")}${requestNote}
For each group also return "rationale": what a reviewer must notice and which evidence proves the explanation. Section authors work from your rationale, so make it concrete.`;

let plan = await agent(planPrompt, {
  label: "plan-groups",
  phase: "Plan",
  schema: planSchema,
});
let violations = plan ? planViolations(plan.groups) : ["planner returned no result"];
if (violations.length > 0) {
  log(`Plan violated coverage invariant (${violations.length} problems); retrying once`);
  plan = await agent(
    `${planPrompt}

A previous plan attempt violated the coverage invariant. Fix these problems and return a corrected plan:
${violations.join("\n")}`,
    { label: "plan-groups-retry", phase: "Plan", schema: planSchema },
  );
  violations = plan ? planViolations(plan.groups) : ["planner returned no result"];
  if (violations.length > 0) {
    throw new Error(`Plan still violates file coverage: ${violations.join("; ")}`);
  }
}
log(`Plan ready: ${plan.groups.length} review groups`);

// ---------------------------------------------------------------------------
// Phase: Author — one agent per group, fanned out. Each writes its section
// MDX (Normal metadata + exactly one Guide block) for its own files only.
// ---------------------------------------------------------------------------
function sectionFileName(group, index) {
  const number = String(index + 1);
  const padded = number.length < 2 ? `0${number}` : number;
  return `sections/${padded}-${group.id}.mdx`;
}

function authorPrompt(group, index) {
  return `${contract}

Author exactly one walkthrough section per SKILL.md steps 2, 4, and 5. Your section file is .pr-walkthrough/walkthrough/${sectionFileName(group, index)} — create it; do not touch any other section or index.mdx.

Group: ${group.title}
- ID: ${group.id} (use this exact ID)
- Objective: ${group.objective}
- Planner rationale: ${group.rationale || "(none provided)"}
- Files owned by this group (your complete and exclusive scope):
${group.files.join("\n")}

Requirements:
- Read .pr-walkthrough/context.json, .pr-walkthrough/evidence.md, and the group's hunks in .pr-walkthrough/changes.patch.
- Read the full current versions of the group's files at the PR head and follow imports, call sites, and tests per SKILL.md step 2 before writing.
- Follow every authoring rule in SKILL.md step 4: heading, ID, Objective, File notes with (-) links, 8-36 word summary sentence, and exactly one ## Guide block with the fixed phase vocabulary.
- Guide excerpts must account for every textual changed line of this group's files exactly once, using L/R selectors against .pr-walkthrough/changes.patch. Classify this group's generated/binary files per SKILL.md (Generated output phase, whole-file (-) items).
- Include existing review comments from evidence.md that anchor to this group's files, per the Comment syntax. Do not invent discussion, findings, severities, or approval language.${requestNote}
Return sectionPath relative to .pr-walkthrough/walkthrough/, ok=true only if the file is written and self-checked against the step 4 rules, and a one-paragraph summary of what the section teaches.`;
}

phase("Author");
const authorSchema = {
  type: "object",
  required: ["ok", "sectionPath"],
  properties: {
    ok: { type: "boolean" },
    sectionPath: { type: "string" },
    summary: { type: "string" },
    problems: { type: "string" },
  },
};

let authored = await pipeline(plan.groups, (group, _item, index) =>
  agent(authorPrompt(group, index), {
    label: `author:${group.id}`,
    phase: "Author",
    schema: authorSchema,
  }),
);

// One bounded retry for authors that died or reported failure.
const failedIndexes = [];
for (let index = 0; index < plan.groups.length; index++) {
  const result = authored[index];
  if (!result || !result.ok) failedIndexes.push(index);
}
if (failedIndexes.length > 0) {
  log(`Retrying ${failedIndexes.length} failed section author(s)`);
  const retried = await parallel(
    failedIndexes.map((index) => () => {
      const group = plan.groups[index];
      const prior = authored[index];
      const priorNote = prior && prior.problems
        ? `\n\nA previous attempt reported these problems — resolve them:\n${prior.problems}`
        : "";
      return agent(`${authorPrompt(group, index)}${priorNote}`, {
        label: `author-retry:${group.id}`,
        phase: "Author",
        schema: authorSchema,
      });
    }),
  );
  for (let position = 0; position < failedIndexes.length; position++) {
    authored[failedIndexes[position]] = retried[position];
  }
  const stillFailed = failedIndexes.filter(
    (index) => !authored[index] || !authored[index].ok,
  );
  if (stillFailed.length > 0) {
    throw new Error(
      `Section authoring failed for groups: ${stillFailed
        .map((index) => plan.groups[index].id)
        .join(", ")}`,
    );
  }
}
log("All sections authored");

// ---------------------------------------------------------------------------
// Phase: Assemble — barrier is correct here: index.mdx and the compile need
// every section present. One agent writes index.mdx and runs the build.
// ---------------------------------------------------------------------------
phase("Assemble");
const buildSchema = {
  type: "object",
  required: ["success"],
  properties: {
    success: { type: "boolean" },
    errorSummary: { type: "string" },
    checksRun: { type: "string" },
  },
};

const buildInstructions = `Build steps (SKILL.md step 6, run all of them):
1. python3 ${skillDir}/scripts/scaffold_site.py --content .pr-walkthrough/walkthrough --diff .pr-walkthrough/changes.patch --output .pr-walkthrough/site
2. pnpm --dir .pr-walkthrough/site install --frozen-lockfile
3. pnpm --dir .pr-walkthrough/site run check
4. python3 ${skillDir}/scripts/validate_site_template.py --site .pr-walkthrough/site --built
Do not pass --include-full-context. Never hand-edit walkthrough.generated.json.
Return success=true only when all four commands pass. On failure, return errorSummary containing the exact compiler/validator errors (verbatim, with the section file each error points at) so a repair agent can act on it.`;
const buildAttemptNote = `This is build attempt ${buildAttempt}. The caller changes this value when resuming after a returned build failure so Assemble and later calls run live instead of replaying cached application-level failures.`;

let build = await agent(
  `${contract}

Write .pr-walkthrough/walkthrough/index.mdx per SKILL.md step 4: frontmatter from .pr-walkthrough/context.json (title, description, summary, baseRef, headRef, headSha, prUrl when present), "# Review guide", a short introduction, and ordered Section references to these files in this exact order:
${plan.groups.map((group, index) => `- [${group.title}](${sectionFileName(group, index)})`).join("\n")}

Then build and validate the static guide.
${buildAttemptNote}
${buildInstructions}`,
  { label: "assemble-and-build", phase: "Assemble", schema: buildSchema },
);

// ---------------------------------------------------------------------------
// Phase: Repair — bounded rounds; each round one agent fixes the reported
// errors in the canonical MDX and reruns the full build.
// ---------------------------------------------------------------------------
const maxRepairRounds = 2;
let repairRounds = 0;
while ((!build || !build.success) && repairRounds < maxRepairRounds) {
  repairRounds++;
  phase("Repair");
  log(`Build failed; repair round ${repairRounds} of ${maxRepairRounds}`);
  build = await agent(
    `${contract}

The walkthrough build failed. Fix the canonical MDX under .pr-walkthrough/walkthrough/ (index.mdx and sections/) so the build passes, then rerun the full build. Only edit MDX authoring — never generated JSON, the site template, or the patch. Preserve the authoring contract in SKILL.md steps 4 and 5, especially exact changed-line Guide coverage.

Errors from the previous attempt:
${(build && build.errorSummary) || "The build agent returned no error detail; rerun the build to reproduce the errors first."}

${buildAttemptNote}
${buildInstructions}`,
    { label: `repair-round-${repairRounds}`, phase: "Repair", schema: buildSchema },
  );
}
if (!build || !build.success) {
  return {
    ready: false,
    stage: "build",
    groups: plan.groups.map((group) => group.id),
    errorSummary: (build && build.errorSummary) || "build agent returned no result",
    nextBuildAttempt: buildAttempt + 1,
  };
}
log("Static guide built and validated");

// ---------------------------------------------------------------------------
// Phase: Validate — serve the export and run the SKILL.md step 8 browser
// checklist. Honest reporting: unverified is a valid outcome.
// ---------------------------------------------------------------------------
phase("Validate");
const validation = await agent(
  `${contract}

Perform SKILL.md step 8 (browser validation) against the freshly built artifact:
- Serve with: python3 -m http.server 4173 --bind 127.0.0.1 --directory .pr-walkthrough/site/out
- Inspect desktop and narrow viewports in a real browser and work through the full step 8 checklist.
- If browser tooling is unavailable, set browserVerified=false and say so; do not infer results from source checks.
Return ready=true only when every applicable check passed. List every failed or unverifiable check in issues.`,
  {
    label: "browser-validate",
    phase: "Validate",
    schema: {
      type: "object",
      required: ["ready", "browserVerified"],
      properties: {
        ready: { type: "boolean" },
        browserVerified: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
    },
  },
);

const browserVerified = Boolean(validation && validation.browserVerified);
const ready = browserVerified && Boolean(validation && validation.ready);
const validationIssues = [...((validation && validation.issues) || [])];
if (!browserVerified && validationIssues.length === 0) {
  validationIssues.push("Browser validation was not completed.");
}

return {
  ready,
  browserVerified,
  stage: "done",
  title: context.title,
  baseRef: context.baseRef,
  headRef: context.headRef,
  headSha: context.headSha,
  prUrl: context.prUrl || null,
  hasComments: Boolean(context.hasComments),
  hasChangedSpecs: Boolean(context.hasChangedSpecs),
  changedFileCount: changedPaths.length,
  groups: plan.groups.map((group, index) => ({
    id: group.id,
    title: group.title,
    section: sectionFileName(group, index),
    fileCount: group.files.length,
  })),
  repairRounds,
  validationIssues,
  validationSummary: (validation && validation.summary) || "",
  sitePath: ".pr-walkthrough/site",
  artifact: ".pr-walkthrough/site/out/index.html",
};
