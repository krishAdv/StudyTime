"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/** Modal built on the native <dialog>: focus trap, Esc to close, backdrop. */
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className="m-auto w-[calc(100%-2rem)] max-w-sm rounded-2xl border border-border bg-card p-0 text-foreground"
    >
      {open && (
        <div className="p-5">
          <h2 id={titleId} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function NameDialog({
  open,
  title,
  label,
  initial = "",
  submitLabel,
  validate,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  /** Live check on the trimmed name; return a message to block submitting. */
  validate?: (name: string) => string | null;
  /** May return an error message (e.g. from the data layer) to keep the dialog open. */
  onSubmit: (name: string) => string | null | void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <NameForm
        label={label}
        initial={initial}
        submitLabel={submitLabel}
        validate={validate}
        onSubmit={(n) => {
          const error = onSubmit(n);
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
function NameForm({
  label,
  initial,
  submitLabel,
  validate,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  submitLabel: string;
  validate?: (name: string) => string | null;
  onSubmit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const errorId = useId();
  const trimmed = name.trim();
  // Stay quiet until something is typed; empty input just disables the button.
  const liveError = trimmed && validate ? validate(trimmed) : null;
  const error = liveError ?? submitError;
  return (
    <form
      className="mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!trimmed || liveError) return;
        setSubmitError(onSubmit(trimmed));
      }}
    >
      <label className="block">
        <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
        <input
          autoFocus
          value={name}
          maxLength={60}
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
      <div className="mt-5 flex justify-end gap-2">
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

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
