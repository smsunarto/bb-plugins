// Shared inline validation state and error display for all bound input
// components, coordinated with Form's Answer Sheet staging guard.
import { createContext, useCallback, useContext, useId, useState } from "react";
import { evaluateChecks, isFieldRequired } from "../../core/checks";
import type { Value } from "../../core/types";
import { FieldError } from "@/components/ui/field";

export interface FormValidationState {
  /** True after the user asks to show all remaining errors (or tries sending an invalid Form). */
  readonly showAll: boolean;
  revealAll(): void;
}

const DEFAULT_FORM_VALIDATION: FormValidationState = {
  showAll: false,
  revealAll() {},
};

export const FormValidationContext = createContext<FormValidationState>(DEFAULT_FORM_VALIDATION);

/** Evaluates `checks` for one input and manages touched/revealed display state. */
export function useFieldValidation(
  value: Value,
  checks: readonly Value[] | undefined,
  componentType: string,
) {
  const form = useContext(FormValidationContext);
  const errorId = useId();
  const [touched, setTouched] = useState(false);
  const touch = useCallback(() => setTouched(true), []);
  const errors = evaluateChecks(value, checks, componentType);
  const required = isFieldRequired(checks);
  const showError = (touched || form.showAll) && errors.length > 0;
  return {
    errors,
    errorId,
    required,
    showError,
    firstError: errors[0] ?? null,
    touch,
  };
}

/** Inline error message below an invalid, touched input (uses semantic `text-destructive`). */
export function FieldValidationMessage({ id, message }: { id: string; message: string | null }) {
  if (message === null) return null;
  return (
    <FieldError id={id} className="text-xs leading-4">
      {message}
    </FieldError>
  );
}
