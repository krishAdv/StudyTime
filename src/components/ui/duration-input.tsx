"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";

const digits = (v: string) => v.replace(/\D/g, "").slice(0, 4);

/**
 * Hours + minutes entry. Only digits can be typed, so negatives and decimals are
 * impossible; the total is validated against min/max minutes. 95 in the minutes
 * box is accepted and tidied to 1h 35m on blur. Reports the total as soon as it
 * is valid (null while it is not), so Start never depends on a blur event.
 */
export function DurationInput({
  initialMinutes,
  minMinutes,
  maxMinutes,
  onChange,
}: {
  initialMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  onChange: (minutes: number | null) => void;
}) {
  const id = useId();
  const [hours, setHours] = useState(String(Math.floor(initialMinutes / 60)));
  const [minutes, setMinutes] = useState(String(initialMinutes % 60));

  const total = (h: string, m: string) => (h === "" && m === "" ? null : Number(h || 0) * 60 + Number(m || 0));
  const validate = (t: number | null) => {
    if (t === null) return "Enter a duration.";
    if (t < minMinutes) return `Enter at least ${minMinutes} minute.`;
    if (t > maxMinutes) return `Maximum is ${maxMinutes / 60} hours.`;
    return null;
  };

  const error = validate(total(hours, minutes));

  const update = (h: string, m: string) => {
    setHours(h);
    setMinutes(m);
    const t = total(h, m);
    onChange(validate(t) === null ? t : null);
  };

  const tidy = () => {
    const t = total(hours, minutes);
    if (t !== null && validate(t) === null) {
      setHours(String(Math.floor(t / 60)));
      setMinutes(String(t % 60));
    }
  };

  const field = (name: string, unit: string, value: string, set: (v: string) => void) => (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        id={`${id}-${name}`}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        enterKeyHint="done"
        autoComplete="off"
        aria-label={unit}
        aria-invalid={error !== null}
        aria-describedby={error ? `${id}-error` : undefined}
        value={value}
        onChange={(e) => set(digits(e.target.value))}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={tidy}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className={cn(
          "h-11 w-full min-w-0 rounded-xl border bg-card px-3 text-center text-base font-medium tabular-nums",
          error ? "border-danger" : "border-border",
        )}
      />
      <span className="text-sm text-muted-foreground">{unit}</span>
    </div>
  );

  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Duration</span>
      <div className="flex items-center gap-3">
        {field("h", "hr", hours, (v) => update(v, minutes))}
        {field("m", "min", minutes, (v) => update(hours, v))}
      </div>
      <p
        id={`${id}-error`}
        role="alert"
        className={cn("mt-1.5 text-xs text-danger", !error && "hidden")}
      >
        {error}
      </p>
    </div>
  );
}
