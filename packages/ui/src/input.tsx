import * as React from "react";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";
function createInput(profile: string) {
  const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
    ({ className, type, ...props }, ref) => (
      <input
        type={type}
        autoComplete="off"
        className={cn(styles["input"] + " " + styles["motion"], profile, className)}
        ref={ref}
        {...props}
      />
    ),
  );
  Input.displayName = "Input";
  return Input;
}
export const Input = createInput("");
export const BorderedInput = createInput(styles["bordered"]);
