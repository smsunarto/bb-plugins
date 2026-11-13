import * as React from "react";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";
import { controlRole, type ControlRole } from "./role";
function createInput(profile: string, role: ControlRole | undefined) {
  const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
    ({ className, type, ...props }, ref) => (
      <input
        type={type}
        autoComplete="off"
        data-bb-control={controlRole(role, className)}
        className={cn(styles["input"] + " " + styles["motion"], profile, className)}
        ref={ref}
        {...props}
      />
    ),
  );
  Input.displayName = "Input";
  return Input;
}
export const Input = createInput("", "field");
export const BorderedInput = createInput(styles["bordered"], undefined);
