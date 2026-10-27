import { generationApprovalPayload, itemBudget, modelLabel } from "@argus-labs/game-studio-api";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Icon } from "./icons.tsx";

/*
 * The form an agent's paid run waits on, in the thread beside the studio. It lists what the
 * run makes and on which model; approving once covers the whole run, and a checkbox approves
 * the game's later agent runs until the person turns it off in the studio.
 */
const kindIcons: Record<string, string> = {
  text: "Type",
  image: "Image",
  video: "Video",
  asset: "Music",
  "model-3d": "Box",
  "animate-3d": "Box",
  agent: "Bot",
  document: "FileText",
  table: "Table",
};

export function GenerationApproval({ interaction, submit }: PluginPendingInteractionProps) {
  const parsed = generationApprovalPayload.safeParse(interaction.payload);
  const [grantGame, setGrantGame] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!parsed.success)
    return <p className="gs-approval-error">This generation request could not be read.</p>;
  const { gameName, items } = parsed.data;
  const total = items.reduce((sum, item) => sum + itemBudget(item), 0);
  const answer = (approved: boolean) => {
    setBusy(true);
    void submit({ approved, ...(approved && grantGame ? { grantGame: true } : {}) }).finally(() =>
      setBusy(false),
    );
  };
  return (
    <div className="gs-approval">
      <p>
        The agent wants to generate for <strong>{gameName}</strong>:
      </p>
      <ul>
        {items.map((item) => (
          <li key={item.requestId}>
            <Icon name={kindIcons[item.kind] ?? "Sparkles"} />
            <span className="gs-approval-title">{item.title}</span>
            <span className="gs-approval-model">
              {modelLabel(item.provider, item.model)}
              {item.count > 1 ? ` ×${item.count}` : ""}
              {item.retries > 0
                ? ` · up to ${item.retries} retr${item.retries === 1 ? "y" : "ies"}`
                : ""}
            </span>
          </li>
        ))}
      </ul>
      <label className="gs-approval-grant">
        <input
          type="checkbox"
          checked={grantGame}
          onChange={(event) => setGrantGame(event.target.checked)}
        />
        Approve the agent&apos;s later runs for {gameName} until it is turned off in the studio
      </label>
      <footer>
        <small>
          Up to {total} generation{total === 1 ? "" : "s"}
        </small>
        <button type="button" disabled={busy} onClick={() => answer(false)}>
          Decline
        </button>
        <button
          type="button"
          className="gs-approval-approve"
          disabled={busy}
          onClick={() => answer(true)}
        >
          Approve
        </button>
      </footer>
    </div>
  );
}
