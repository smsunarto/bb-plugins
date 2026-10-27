import { useState } from "react";
import { useComposer, experimental_useComposerRenderer } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export function SaveDraftAction({ available }: { available: boolean }) {
  const composer = useComposer();
  const renderer = experimental_useComposerRenderer();
  const [saving, setSaving] = useState(false);

  if (
    !available ||
    composer.scope.kind === "queued-message" ||
    (renderer.input.surface === "thread" && composer.scope.kind !== "thread")
  )
    return null;

  const disabled = saving || composer.isEmpty || composer.isSubmittingBlocked;
  const save = async () => {
    if (disabled) return;
    setSaving(true);
    try {
      await composer.submit({
        experimental_mode: "queue-if-active",
        experimental_data: { kind: "draft" },
      });
    } catch (error) {
      renderer.showError(error instanceof Error ? error.message : "Could not save draft");
    } finally {
      setSaving(false);
    }
  };

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-t3-composer-save-draft=""
            aria-label="Save draft"
            disabled={disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={save}
          >
            <Icon name="EditFile" className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">Save draft</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
