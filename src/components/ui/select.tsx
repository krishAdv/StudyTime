import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/** Native select (best picker UX on iOS) with a consistent look. */
export function Select({
  label,
  className,
  children,
  ...props
}: React.ComponentProps<"select"> & { label: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="relative block">
        <select
          className="h-11 w-full appearance-none rounded-xl border border-border bg-card pl-3 pr-9 text-base text-foreground disabled:opacity-50 sm:text-sm"
          {...props}
        >
          {children}
        </select>
        <ChevronDown
          aria-hidden
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        />
      </span>
    </label>
  );
}
