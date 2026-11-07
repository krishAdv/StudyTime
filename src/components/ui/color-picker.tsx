"use client";

import { useId } from "react";
import { Check } from "lucide-react";
import { CLASS_COLOR_OPTIONS, colorName, contrastingInk, type ClassColorOption } from "@/lib/class-colors";
import { cn } from "@/lib/utils";

/**
 * Preset color swatches as a native radio group (arrow keys move between colors, screen readers
 * announce the color name and whether it is selected). A current value that is not a preset (e.g.
 * from an imported backup) is shown as an extra "Custom" swatch so editing never changes it silently.
 */
export function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  const name = useId();
  const labelId = useId();
  const options: readonly ClassColorOption[] =
    colorName(value) === null ? [...CLASS_COLOR_OPTIONS, { value, name: "Custom" }] : CLASS_COLOR_OPTIONS;
  const selected = value.toLowerCase();

  return (
    <div role="radiogroup" aria-labelledby={labelId}>
      <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span id={labelId}>{label}</span>
        <span className="flex items-center gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: value }} />
          {colorName(value) ?? "Custom"}
        </span>
      </div>
      <div className="grid grid-cols-6 justify-items-center gap-1">
        {options.map((o) => {
          const checked = o.value.toLowerCase() === selected;
          return (
            <label key={o.value} className="relative flex h-11 w-11 cursor-pointer items-center justify-center">
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                aria-label={o.name}
                className="peer sr-only"
              />
              <span
                aria-hidden
                style={{ backgroundColor: o.value, color: contrastingInk(o.value) }}
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full ring-offset-2 ring-offset-card transition-shadow",
                  "peer-focus-visible:ring-2 peer-focus-visible:ring-primary",
                  checked && "ring-2 ring-foreground",
                )}
              >
                {checked && <Check className="h-4 w-4" strokeWidth={3} />}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
