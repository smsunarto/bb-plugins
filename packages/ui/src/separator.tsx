import * as React from "react";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";

export interface SeparatorProps extends React.HTMLAttributes<HTMLDivElement> {
  orientation?: "horizontal" | "vertical";
  /** A decorative rule is hidden from assistive technology. */
  decorative?: boolean;
}

export const Separator = React.forwardRef<HTMLDivElement, SeparatorProps>(
  ({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="separator"
      data-orientation={orientation}
      {...(decorative ? { role: "none" } : { role: "separator", "aria-orientation": orientation })}
      className={cn(styles["separator"], className)}
      {...props}
    />
  ),
);
Separator.displayName = "Separator";
