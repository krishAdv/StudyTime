"use client";

import { useId, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Button } from "./button";
import { cn } from "@/lib/utils";

export function NumberStepper({
  label,
  hint,
  unit,
  value,
  min,
  max,
  step = 1,
  onChange,
  className,
}: {
  label: string;
  hint?: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  className?: string;
}) {
  // Local text lets people clear the field while typing; commit on blur.
  const inputId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null) {
      const n = Number(draft);
      if (draft.trim() !== "" && Number.isFinite(n)) onChange(Math.min(max, Math.max(min, Math.round(n))));
      setDraft(null);
    }
  };

  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <div className="min-w-0">
        <label htmlFor={inputId} className="text-sm font-medium">
          {label}
        </label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="secondary"
          size="icon"
          aria-label={`Decrease ${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
        >
          <Minus className="h-4 w-4" />
        </Button>
        <div className="flex w-20 items-baseline justify-center gap-1">
          <input
            id={inputId}
            inputMode="numeric"
            value={draft ?? String(value)}
            onChange={(e) => setDraft(e.target.value.replace(/[^\d]/g, ""))}
            onBlur={commit}
            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
            className="h-11 w-10 rounded-lg bg-transparent text-center text-base font-medium tabular-nums"
          />
          <span className="text-xs text-muted-foreground">{unit}</span>
        </div>
        <Button
          variant="secondary"
          size="icon"
          aria-label={`Increase ${label}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
