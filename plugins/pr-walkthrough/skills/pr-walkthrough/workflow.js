export const meta = {
  name: "pr-walkthrough",
  description:
    "Generate a PR walkthrough: collect context, plan semantic review groups, author sections in parallel, compile the walkthrough, and repair failures",
  phases: [
    { title: "Context", detail: "Collect PR metadata, diff, and existing review evidence" },
    { title: "Plan", detail: "Group changed files into ordered semantic review groups" },
    { title: "Author", detail: "One agent per group writes its section MDX with a Guide block" },
    { title: "Assemble", detail: "Write index.mdx, compile the walkthrough, and verify it" },
    { title: "Repair", detail: "Fix compiler failures, then recompile" },
  ],
};

// Runtime-neutral: runs unchanged under bb (bb_workflow_run / bb workflows run)
// and Claude Code (Workflow). Neither host-specific reporting rule lives here.
//
// args:
//   skillDir (required) — absolute path to the pr-walkthrough skill directory
//                         (contains SKILL.md, scripts/, workflow.js).
//   request  (optional)  — user constraints: base branch override, PR selection, emphasis.
const skillDir = args && args.skillDir;
if (!skillDir) {
  throw new Error(
    "args.skillDir is required: absolute path to the pr-walkthrough skill directory",
  );
}
const request = (args && args.request) || "";

// ---------------------------------------------------------------------------
// Cache discipline
//
// Two caches pay for the prompt layout below, and both reward the same shape.
//
// 1. Provider prompt cache. Sibling agents reuse a byte-identical leading
//    prefix. So every prompt is PREAMBLE + a task block that is constant across
//    the agents of its phase + a short variable tail. The fan-out phase
//    (Author) benefits most: N agents share everything except their group block.
//
// 2. Workflow resume cache. A resumed run replays the longest unchanged prefix
//    of agent() calls, matched on (prompt, opts). So prompts must be
//    deterministic across runs: no timestamps, no run counters, no live-varying
//    ordering. Model-supplied lists are sorted before they reach a prompt, so a
//    reordered Context result cannot invalidate Plan and every phase after it.
//
// Rules for editing this file:
// - Append to a prompt tail; do not rewrite a shared block for one agent.
// - Keep labels stable. A renamed label is a new call and misses the cache.
// - Add new phases at the end where possible. An edit early in the script
//   invalidates every call after it.
// ---------------------------------------------------------------------------

const requestBlock = request
  ? `\n\nUser constraints for this run. They outrank the defaults in SKILL.md where the two conflict:\n${request}`
  : "";

// Byte-identical first bytes of every agent prompt in every phase.
const PREAMBLE = `Read ${skillDir}/SKILL.md before doing anything else. It is the authoritative contract for this task and it outranks any summary in this prompt.

Work in the current workspace repository root. All walkthrough state lives under .pr-walkthrough/ in the workspace:
- .pr-walkthrough/changes.patch — the canonical diff.
- .pr-walkthrough/context.json — PR metadata and the changed-file list.
- .pr-walkthrough/evidence.md — existing review comments and spec pointers.
- .pr-walkthrough/assets/ — downloaded PR images and exports.
- .pr-walkthrough/walkthrough/ — canonical MDX: index.mdx plus sections/.
- .pr-walkthrough/walkthrough.generated.json — the compiled artifact the bb viewer reads.

This skill orients a reviewer. It does not perform a code review. Never fabricate evidence, findings, severities, or approval language. Record honestly what was unavailable.${requestBlock}

---

`;

// Sorting a model-supplied list keeps downstream prompts stable across runs.
function sortedPaths(paths) {
  return paths.slice().sort();
}

// ---------------------------------------------------------------------------
// Phase: Context — one agent establishes PR context and shared evidence files.
// ---------------------------------------------------------------------------
phase("Context");
log("Collecting PR context and diff");

const context = await agent(
  `${PREAMBLE}Perform SKILL.md step 1 ("Establish pull-request context") and the evidence-gathering half of step 2 exactly:
- Identify the repository root, current branch, and comparison base (GitHub PR base when one exists, otherwise the remote default branch).
- Write the canonical patch to .pr-walkthrough/changes.patch with the exact git command in SKILL.md.
- Collect PR title, body, URL, state, and every existing review/issue comment when a PR exists.
- Download useful PR images or exports into .pr-walkthrough/assets/. Do not hotlink.
- Write .pr-walkthrough/context.json containing: baseRef, headRef, headSha, title, prUrl (null when absent), and the full changed-file list with per-file status and add/delete counts.
- Write .pr-walkthrough/evidence.md containing existing review comments (verbatim, attributed, with URLs), pointers to PR-changed specs, and notes on which evidence kinds exist. Later agents read this file instead of re-querying GitHub.

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
const changedPaths = sortedPaths(context.files.map((file) => file.path));
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

// Shared block first, then the variable file list. The retry appends to this
// exact string so the whole plan prompt stays a cached prefix of the retry.
const planPrompt = `${PREAMBLE}Perform the planning half of SKILL.md steps 2 and 3. Read .pr-walkthrough/context.json, .pr-walkthrough/evidence.md, and .pr-walkthrough/changes.patch, and read the checkout at the PR head as architecture truth. Group files by implementation purpose, not path or file type. Scale group count to the change per SKILL.md step 2 and do not inflate small pull requests. Order groups in the intended review order: foundations before behavior before integration.

Assign every changed file listed below to exactly one group, generated artifacts included. Generated artifacts stay in their owning group; the section author classifies them. Use unique lowercase kebab-case group ids.

For each group also return "rationale": what a reviewer must notice and which evidence proves the explanation. Section authors work from your rationale, so make it concrete.

Changed files:
${changedPaths.join("\n")}`;

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
//
// This is the widest fan-out, so the shared instructions sit ahead of the
// per-group block: every author agent shares PREAMBLE + AUTHOR_TASK verbatim.
// ---------------------------------------------------------------------------
function sectionFileName(group, index) {
  const number = String(index + 1);
  const padded = number.length < 2 ? `0${number}` : number;
  return `sections/${padded}-${group.id}.mdx`;
}

const AUTHOR_TASK = `Author exactly one walkthrough section per SKILL.md steps 2, 4, and 5. The Assignment block at the end of this prompt names your section file, your group, and the files you own. Create that one file. Do not touch any other section, and do not touch index.mdx.

Requirements:
- Read .pr-walkthrough/context.json, .pr-walkthrough/evidence.md, and your group's hunks in .pr-walkthrough/changes.patch.
- Read the full current versions of your group's files at the PR head and follow imports, call sites, and tests per SKILL.md step 2 before writing.
- Follow every authoring rule in SKILL.md step 4: heading, ID, Objective, File notes with (-) links, an 8-36 word summary sentence, and exactly one ## Guide block using the fixed phase vocabulary.
- Guide excerpts must account for every textual changed line of your group's files exactly once, using L/R selectors against .pr-walkthrough/changes.patch. Classify your group's generated and binary files per SKILL.md: whole-file (-) items in the Generated output phase.
- Include existing review comments from evidence.md that anchor to your group's files, per the Comment syntax. Do not invent discussion, findings, severities, or approval language.

Return sectionPath relative to .pr-walkthrough/walkthrough/, ok=true only when the file is written and self-checked against the step 4 rules, and a one-paragraph summary of what the section teaches. When ok is false, put the exact blockers in problems.

`;

function authorPrompt(group, index) {
  return `${PREAMBLE}${AUTHOR_TASK}Assignment:
- Section file: .pr-walkthrough/walkthrough/${sectionFileName(group, index)}
- Group title: ${group.title}
- Group ID: ${group.id} (use this exact ID)
- Objective: ${group.objective}
- Planner rationale: ${group.rationale || "(none provided)"}
- Files owned by this group, your complete and exclusive scope:
${sortedPaths(group.files).join("\n")}`;
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

// Shared verbatim by Assemble and every Repair round.
const BUILD_TASK = `Compile the walkthrough (SKILL.md step 6):
python3 ${skillDir}/scripts/compile_walkthrough.py --input .pr-walkthrough/walkthrough --diff .pr-walkthrough/changes.patch --output .pr-walkthrough/walkthrough.generated.json

Do not pass --include-full-context. Never hand-edit walkthrough.generated.json.

Then verify per SKILL.md step 8: the command exited zero, the JSON exists and is non-empty, its reviewGroups count equals the number of section files, and its diffFiles count equals the changed-file count in .pr-walkthrough/context.json.

Return success=true only when the compile exits zero and every step 8 check passes. On failure, return errorSummary containing the exact compiler errors, verbatim, with the section file each error points at, so a repair agent can act on it.

`;

let build = await agent(
  `${PREAMBLE}${BUILD_TASK}Before compiling, write .pr-walkthrough/walkthrough/index.mdx per SKILL.md step 4: frontmatter from .pr-walkthrough/context.json (title, description, summary, baseRef, headRef, headSha, and prUrl when present), "# Review guide", a short introduction, and ordered Section references to these files in this exact order:
${plan.groups.map((group, index) => `- [${group.title}](${sectionFileName(group, index)})`).join("\n")}`,
  { label: "assemble-and-build", phase: "Assemble", schema: buildSchema },
);

// ---------------------------------------------------------------------------
// Phase: Repair — bounded rounds; each round one agent fixes the reported
// errors in the canonical MDX and reruns the full build.
// ---------------------------------------------------------------------------
const REPAIR_TASK = `The walkthrough compile failed. Fix the canonical MDX under .pr-walkthrough/walkthrough/ (index.mdx and sections/) so it compiles, then rerun the compile. Only edit MDX authoring. Never edit the generated JSON or the patch. Preserve the authoring contract in SKILL.md steps 4 and 5, especially exact changed-line Guide coverage.

`;

const maxRepairRounds = 2;
let repairRounds = 0;
while ((!build || !build.success) && repairRounds < maxRepairRounds) {
  repairRounds++;
  phase("Repair");
  log(`Compile failed; repair round ${repairRounds} of ${maxRepairRounds}`);
  build = await agent(
    `${PREAMBLE}${BUILD_TASK}${REPAIR_TASK}Errors from the previous attempt:
${(build && build.errorSummary) || "The build agent returned no error detail; rerun the build to reproduce the errors first."}`,
    { label: `repair-round-${repairRounds}`, phase: "Repair", schema: buildSchema },
  );
}
if (!build || !build.success) {
  return {
    built: false,
    stage: "compile",
    groups: plan.groups.map((group) => group.id),
    errorSummary: (build && build.errorSummary) || "build agent returned no result",
  };
}
log("Walkthrough compiled and verified");

// The workflow ends at a successful compile. Rendering happens in the bb viewer
// panel, which no agent here can see, so nothing below claims it was viewed.
return {
  built: true,
  stage: "compiled",
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
  checksRun: (build && build.checksRun) || "",
  walkthroughPath: ".pr-walkthrough/walkthrough",
  dataPath: ".pr-walkthrough/walkthrough.generated.json",
  directivePath: ".pr-walkthrough",
};
