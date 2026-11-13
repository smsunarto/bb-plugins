import * as React from "react";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";
import { controlRole } from "./role";
export const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea
      data-bb-control={controlRole("field", className)}
      className={cn(styles["textarea"] + " " + styles["motion"], className)}
      ref={ref}
      {...props}
    />
  ),
);
Textarea.displayName = "Textarea";
