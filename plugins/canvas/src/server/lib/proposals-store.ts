import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  applyReplacement,
  proposalsFileSchema,
  type Proposal,
  type ProposalsFile,
} from "../../shared/proposals.ts";
import type { CanvasSource } from "../../shared/source.ts";
import { locateSource, type FileLocation } from "../locate.ts";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sidecar = (location: FileLocation): FileLocation => ({
  ...location,
  path: `${location.path}.suggestions.json`,
});
async function locationOf(bb: BbPluginApi, source: CanvasSource) {
  const located = await locateSource(bb, source);
  if (!located.ok) throw new Error(located.detail);
  return located.location;
}
async function readAt(
  bb: BbPluginApi,
  location: FileLocation,
): Promise<{ file: ProposalsFile; sha256: string | null }> {
  let raw;
  try {
    raw = await bb.sdk.files.read(sidecar(location));
  } catch (error) {
    if (/ENOENT|no such file|not found|does not exist|ENOTDIR/i.test(String(error)))
      return { file: { version: 1, proposals: [] }, sha256: null };
    throw error;
  }
  if (raw.contentEncoding !== "utf8") throw new Error("The suggestions file must be UTF-8 JSON.");
  const parsed = proposalsFileSchema.safeParse(JSON.parse(raw.content));
  if (!parsed.success) throw new Error(`Invalid suggestions file: ${parsed.error.message}`);
  return { file: parsed.data, sha256: raw.sha256 };
}
export async function readProposals(bb: BbPluginApi, source: CanvasSource) {
  return { file: (await readAt(bb, await locationOf(bb, source))).file };
}
async function writeAt(
  bb: BbPluginApi,
  location: FileLocation,
  file: ProposalsFile,
  sha256: string | null,
) {
  const result = await bb.sdk.files.write({
    ...sidecar(location),
    content: `${JSON.stringify(file, null, 2)}\n`,
    contentEncoding: "utf8",
    expectedSha256: sha256,
  });
  if (result.outcome !== "written")
    throw new Error("Suggestions changed while reviewing. Retry with the latest version.");
  return result.sha256;
}
function sameEdit(a: Proposal, b: Proposal) {
  return (
    a.id === b.id &&
    a.before === b.before &&
    a.after === b.after &&
    a.title === b.title &&
    a.author === b.author &&
    a.createdAtMs === b.createdAtMs
  );
}
export async function decideProposal(
  bb: BbPluginApi,
  input: {
    source: CanvasSource;
    proposal: Proposal;
    decision: "accept" | "reject";
    expectedContent: string;
  },
) {
  const location = await locationOf(bb, input.source);
  const current = await readAt(bb, location);
  const found = current.file.proposals.find((p) => p.id === input.proposal.id);
  let proposal: Proposal;
  if (!found || !sameEdit(found, input.proposal))
    throw new Error("This proposal changed. Review the latest version before deciding.");
  proposal = found;
  const document = await bb.sdk.files.read(location);
  if (document.contentEncoding !== "utf8") throw new Error("Canvas must be UTF-8 text.");
  if (proposal.status === "accepted" || proposal.status === "rejected") {
    if (proposal.status !== (input.decision === "accept" ? "accepted" : "rejected"))
      throw new Error("This proposal has already been decided.");
    if (input.decision === "accept" && document.content !== input.expectedContent)
      throw new Error("This edit was already accepted. Reload the canvas before continuing.");
    return { file: current.file, content: document.content, sha256: document.sha256 };
  }
  if (input.decision === "reject") {
    if (proposal.status === "applying")
      throw new Error("This edit is being applied. Retry Accept to finish recording it.");
    const file: ProposalsFile = {
      ...current.file,
      proposals: current.file.proposals.map((p) =>
        p.id === proposal.id ? { ...p, status: "rejected", decidedAtMs: Date.now() } : p,
      ),
    };
    await writeAt(bb, location, file, current.sha256);
    return { file, content: document.content, sha256: document.sha256 };
  }
  const prepared = await applyAcceptedEdit(
    bb,
    location,
    current,
    proposal,
    document,
    input.expectedContent,
  );
  return recordAcceptance(bb, location, prepared.proposal, prepared.content);
}

async function applyAcceptedEdit(
  bb: BbPluginApi,
  location: FileLocation,
  current: { file: ProposalsFile; sha256: string | null },
  proposal: Proposal,
  document: { content: string; sha256: string },
  expectedContent: string,
) {
  // An applying receipt survives an interrupted source write or receipt write.
  // Never apply the same replacement twice, even when `after` contains `before`.
  let content = document.content;
  if (proposal.status === "applying" && !proposal.receipt)
    throw new Error("The applying proposal is missing its receipt.");
  const alreadyWritten =
    proposal.status === "applying" && document.sha256 === proposal.receipt?.afterSha256;
  if (
    alreadyWritten &&
    document.content !== expectedContent &&
    hash(expectedContent) !== proposal.receipt?.beforeSha256
  ) {
    throw new Error(
      "The edit landed, but you have newer unsaved changes. Save or reload before finishing acceptance.",
    );
  }
  if (!alreadyWritten) {
    if (document.content !== expectedContent)
      throw new Error(
        "The canvas has unsaved edits or changed on disk. Wait for it to save or reload before accepting.",
      );
    if (proposal.status === "applying" && document.sha256 !== proposal.receipt?.beforeSha256)
      throw new Error(
        "The canvas changed during acceptance. Review the receipt before updating this proposal.",
      );
    content = applyReplacement(document.content, proposal);
    if (proposal.status === "pending") {
      proposal = {
        ...proposal,
        status: "applying",
        receipt: { beforeSha256: document.sha256, afterSha256: hash(content) },
      };
      const file = {
        ...current.file,
        proposals: current.file.proposals.map((p) => (p.id === proposal.id ? proposal : p)),
      };
      await writeAt(bb, location, file, current.sha256);
    } else if (hash(content) !== proposal.receipt?.afterSha256) {
      throw new Error(
        "The applying edit was modified. Restore the proposal recorded in its receipt.",
      );
    }
    const written = await bb.sdk.files.write({
      ...location,
      content,
      contentEncoding: "utf8",
      expectedSha256: document.sha256,
    });
    if (written.outcome !== "written")
      throw new Error(
        "The canvas changed while accepting. Retry after reviewing the current source.",
      );
  }
  return { proposal, content };
}

async function recordAcceptance(
  bb: BbPluginApi,
  location: FileLocation,
  proposal: Proposal,
  content: string,
) {
  // Merge the decision into the freshest sidecar, retaining agent replies/edits.
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readAt(bb, location);
    const recorded = current.file.proposals.find((p) => p.id === proposal.id);
    if (
      !recorded ||
      !sameEdit(recorded, proposal) ||
      recorded.receipt?.afterSha256 !== proposal.receipt?.afterSha256
    )
      throw new Error(
        "The source was updated, but its proposal changed. Restore the applying receipt to finish recording acceptance.",
      );
    const file: ProposalsFile = {
      ...current.file,
      proposals: current.file.proposals.map((p) =>
        p.id === proposal.id ? { ...p, status: "accepted", decidedAtMs: Date.now() } : p,
      ),
    };
    try {
      await writeAt(bb, location, file, current.sha256);
      return { file, content, sha256: hash(content) };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  throw new Error("Could not record acceptance. Retry Accept to finish.");
}
