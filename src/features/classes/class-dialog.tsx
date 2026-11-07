"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { ColorPicker } from "@/components/ui/color-picker";
import { Modal } from "@/components/ui/dialogs";
import { MAX_NAME_LENGTH } from "@/lib/class-rules";
import { cn } from "@/lib/utils";

/** Create / edit a class: its name and its color. Validation messages come from class-rules. */
export function ClassDialog({
  open,
  title,
  submitLabel,
  initialName = "",
  initialColor,
  validate,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  submitLabel: string;
  initialName?: string;
  initialColor: string;
  /** Live check on the trimmed name; return a message to block submitting. */
  validate: (name: string) => string | null;
  /** May return an error message (e.g. from the data layer) to keep the dialog open. */
  onSubmit: (value: { name: string; color: string }) => string | null;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <ClassForm
        initialName={initialName}
        initialColor={initialColor}
        submitLabel={submitLabel}
        validate={validate}
        onSubmit={(v) => {
          const error = onSubmit(v);
          if (error) return error;
          onClose();
          return null;
        }}
        onCancel={onClose}
      />
    </Modal>
  );
}

// Mounted only while the dialog is open, so the draft resets every time.
function ClassForm({
  initialName,
  initialColor,
  submitLabel,
  validate,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialColor: string;
  submitLabel: string;
  validate: (name: string) => string | null;
  onSubmit: (value: { name: string; color: string }) => string | null;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [color, setColor] = useState(initialColor);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const errorId = useId();
  const trimmed = name.trim();
  const liveError = trimmed ? validate(trimmed) : null;
  const error = liveError ?? submitError;
  return (
    <form
      className="mt-4 space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed || liveError) return;
        setSubmitError(onSubmit({ name: trimmed, color }));
      }}
    >
      <div>
        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Class name</span>
          <input
            autoFocus
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(e) => {
              setName(e.target.value);
              setSubmitError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={cn(
              "h-11 w-full rounded-xl border bg-background px-3 text-base sm:text-sm",
              error ? "border-danger" : "border-border",
            )}
          />
        </label>
        {error && (
          <p id={errorId} role="alert" className="mt-1.5 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <ColorPicker
        label="Color"
        value={color}
        onChange={(c) => {
          setColor(c);
          setSubmitError(null);
        }}
      />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={!trimmed || !!liveError}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
