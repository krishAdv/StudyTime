import { cn } from "@/lib/utils";

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  icon?: React.ReactNode;
};

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  className,
}: {
  label: string;
  value: T;
  options: SegmentOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("flex gap-1 rounded-xl bg-muted p-1", disabled && "opacity-50", className)}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors",
              active
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
