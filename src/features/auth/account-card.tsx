"use client";

import { useId, useState } from "react";
import { KeyRound, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { MIN_PASSWORD_LENGTH, useAuth } from "./auth-provider";
import { SignInForm, inputClass } from "./sign-in-form";

function ChangePasswordForm() {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const errorId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setDone(false);
    if (next !== confirm) {
      setError("The new passwords don’t match.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await changePassword(current, next);
    setBusy(false);
    if (r.ok) {
      setCurrent("");
      setNext("");
      setConfirm("");
      setDone(true);
    } else {
      setError(r.error);
    }
  }

  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    autoComplete: string,
    name: string,
  ) => (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="password"
        name={name}
        autoComplete={autoComplete}
        required
        value={value}
        onChange={(e) => {
          set(e.target.value);
          setError(null);
          setDone(false);
        }}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(inputClass, error ? "border-danger" : "border-border")}
      />
    </label>
  );

  return (
    <form onSubmit={submit} className="mt-6 border-t border-border pt-5">
      <h3 className="text-sm font-semibold tracking-tight">Change password</h3>
      <p className="mb-4 mt-0.5 text-xs text-muted-foreground">
        At least {MIN_PASSWORD_LENGTH} characters. Other devices stay signed in.
      </p>
      <div className="space-y-3">
        {field("Current password", current, setCurrent, "current-password", "current-password")}
        {field("New password", next, setNext, "new-password", "new-password")}
        {field("Confirm new password", confirm, setConfirm, "new-password", "confirm-password")}
      </div>
      {error && (
        <p id={errorId} role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
      {done && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          Password changed.
        </p>
      )}
      <Button type="submit" variant="secondary" className="mt-4" disabled={busy}>
        <KeyRound className="h-4 w-4" aria-hidden /> {busy ? "Changing…" : "Change password"}
      </Button>
    </form>
  );
}

/**
 * Settings card: sign in or out, and change the password. Study data is saved on this
 * device under the signed-in account (no sync yet). `timerActive` blocks signing out
 * while a session is running, since the timer belongs to the signed-in account.
 */
export function AccountCard({ timerActive }: { timerActive: boolean }) {
  const { status, user, signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function leave() {
    if (busy || timerActive) return;
    setBusy(true);
    setError(null);
    const r = await signOut();
    setBusy(false);
    if (!r.ok) setError(r.error);
  }

  return (
    <Card>
      <CardTitle>Account</CardTitle>
      {status === "disabled" && (
        <p className="mt-0.5 text-sm text-muted-foreground">
          Accounts aren’t set up for this copy of StudyTime, so everything stays on this device.
        </p>
      )}
      {status === "loading" && (
        <p role="status" className="mt-0.5 text-sm text-muted-foreground">
          Checking sign-in…
        </p>
      )}
      {status === "signed-in" && (
        <>
          <p className="mb-4 mt-0.5 text-sm text-muted-foreground">
            Signed in as <span className="font-medium text-foreground">{user?.email ?? "your account"}</span>. Your
            study data is saved on this device under this account only; syncing between devices comes later.
            Signing out doesn’t remove it.
          </p>
          <Button variant="secondary" onClick={leave} disabled={busy || timerActive}>
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </Button>
          {timerActive && (
            <p className="mt-3 text-xs text-muted-foreground">
              Stop the running timer before signing out, so the session is saved to this account.
            </p>
          )}
          <ChangePasswordForm />
        </>
      )}
      {status === "signed-out" && <SignInForm intro="Sign in to open your study data." />}
      {status === "signed-in" && error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
