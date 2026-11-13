import * as React from "react";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";

function part(name: string, style: string) {
  const Part = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ className, ...props }, ref) => (
      <div ref={ref} data-slot={name} className={cn(style, className)} {...props} />
    ),
  );
  Part.displayName = name;
  return Part;
}

export const Card = part("card", styles["card"]);
export const CardHeader = part("card-header", styles["card-header"]);
export const CardTitle = part("card-title", styles["card-title"]);
export const CardDescription = part("card-description", styles["card-description"]);
export const CardContent = part("card-content", styles["card-content"]);
export const CardFooter = part("card-footer", styles["card-footer"]);
