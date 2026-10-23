import * as React from "react";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea
      className={cn(styles["textarea"] + " " + styles["motion"], className)}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
