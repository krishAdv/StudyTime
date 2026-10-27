import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-foreground hover:opacity-90",
  secondary: "bg-muted text-foreground hover:bg-border",
  ghost: "text-foreground hover:bg-muted",
  danger: "bg-danger text-background hover:opacity-90",
};

const sizes: Record<Size, string> = {
  md: "h-11 px-4 text-sm gap-2",
  lg: "h-14 px-6 text-base gap-2 rounded-2xl",
  icon: "h-11 w-11",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-xl font-medium transition-colors select-none disabled:pointer-events-none disabled:opacity-40",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
