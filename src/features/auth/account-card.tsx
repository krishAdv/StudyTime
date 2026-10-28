"use client";

import { useId, useState } from "react";
import { LogIn, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useAuth } from "./auth-provider";

const inputClass = "h-11 w-full rounded-xl border bg-background px-3 text-base sm:text-sm";

/** Settings card: sign in or out. Study data stays on this device either way (no sync yet). */
export function AccountCard() {
  const { status, user, signIn, signOut } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await signIn(email, password);
    setBusy(false);
    if (r.ok) setPassword("");
    else setError(r.error);
  }

  async function leave() {
    if (busy) return;
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
            study data is still saved on this device only; syncing between devices comes later. Signing out doesn’t
            remove it.
          </p>
          <Button variant="secondary" onClick={leave} disabled={busy}>
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </Button>
        </>
      )}
      {status === "signed-out" && (
        <form onSubmit={submit} className="mt-0.5">
          <p className="mb-4 text-sm text-muted-foreground">
            Sign in to get ready for syncing between your devices. You can keep using StudyTime without an account.
          </p>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Email</span>
              <input
                type="email"
                name="email"
                autoComplete="username"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className={cn(inputClass, error ? "border-danger" : "border-border")}
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Password</span>
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                className={cn(inputClass, error ? "border-danger" : "border-border")}
              />
            </label>
          </div>
          {error && (
            <p id={errorId} role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          )}
          <Button type="submit" className="mt-4" disabled={busy}>
            <LogIn className="h-4 w-4" aria-hidden /> {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      )}
      {status === "signed-in" && error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
