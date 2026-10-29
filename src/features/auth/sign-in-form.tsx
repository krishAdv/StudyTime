"use client";

import { useId, useState } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAuth } from "./auth-provider";

export const inputClass = "h-11 w-full rounded-xl border bg-background px-3 text-base sm:text-sm";

/** Email + password form shared by the sign-in wall and the Settings account card. */
export function SignInForm({ intro }: { intro: string }) {
  const { signIn } = useAuth();
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

  return (
    <form onSubmit={submit} className="mt-0.5">
      <p className="mb-4 text-sm text-muted-foreground">{intro}</p>
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
  );
}
