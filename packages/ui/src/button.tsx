import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./utils";
import "./controls.css";
import { styles } from "./styles";
import { controlRole, type ControlRole } from "./role";

const buttonVariants = cva(styles["button"] + " " + styles["motion"], {
  variants: {
    variant: {
      default: styles["default"],
      destructive: styles["destructive"],
      outline: styles["outline"],
      secondary: styles["secondary"],
      ghost: styles["ghost"],
      link: styles["link"],
    },
    size: {
      default: styles["size-default"],
      sm: styles["size-sm"],
      lg: styles["size-lg"],
      icon: styles["size-icon"],
    },
  },
  defaultVariants: { variant: "default", size: "default" },
});
const buttonRole: Partial<Record<string, ControlRole>> = {
  default: "primary",
  outline: "outline",
  secondary: "secondary",
};
const compactRole: Partial<Record<string, ControlRole>> = { default: "primary" };

export interface ButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
function createButton(profile: string, roles: boolean) {
  const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
      const Comp = asChild ? Slot : "button";
      return (
        <Comp
          data-slot="button"
          data-bb-control={
            roles ? controlRole(buttonRole[variant ?? "default"], className) : undefined
          }
          className={cn(buttonVariants({ variant, size }), profile, className)}
          ref={ref}
          {...props}
        />
      );
    },
  );
  Button.displayName = "Button";
  return Button;
}
const Button = createButton("", true);
// The bordered profile keeps its border-colored edge, which the outline role would replace.
const BorderedButton = createButton(styles["bordered"], false);
const NativeButton = createButton(styles["native"], true);
const borderedButtonVariants: typeof buttonVariants = (props) =>
  cn(buttonVariants(props), styles["bordered"]);
const nativeButtonVariants: typeof buttonVariants = (props) =>
  cn(buttonVariants(props), styles["native"]);
export {
  Button,
  BorderedButton,
  NativeButton,
  buttonVariants,
  borderedButtonVariants,
  nativeButtonVariants,
};

const compactVariants = cva(styles["button"] + " " + styles["motion"] + " " + styles["compact"], {
  variants: {
    variant: {
      default: styles["default"],
      outline: styles["outline"],
      ghost: styles["ghost"],
      destructive: styles["destructive"],
    },
    size: { default: styles["size-default"], sm: styles["size-sm"], xs: styles["size-xs"] },
  },
  defaultVariants: { variant: "default", size: "default" },
});
export interface CompactButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof compactVariants> {}
export const CompactButton = React.forwardRef<HTMLButtonElement, CompactButtonProps>(
  ({ className, variant, size, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      data-bb-control={controlRole(compactRole[variant ?? "default"], className)}
      className={cn(compactVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
CompactButton.displayName = "CompactButton";
