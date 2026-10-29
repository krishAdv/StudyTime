"use client";

import { Loader2, Timer } from "lucide-react";
import { Card, CardTitle } from "@/components/ui/card";
import { SignInForm } from "./sign-in-form";

/**
 * Shown instead of the whole app while Supabase is configured and nobody is signed in.
 * It renders no study data and mounts no data provider, so nothing from any account
 * (or from the legacy device bucket) can appear here.
 */
export function SignInWall({ checking }: { checking: boolean }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-4 py-10">
      <div className="mb-6 flex items-center justify-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Timer className="h-5 w-5" aria-hidden />
        </span>
        <span className="text-lg font-semibold tracking-tight">StudyTime</span>
      </div>
      <Card>
        {checking ? (
          <p role="status" className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Checking sign-in…
          </p>
        ) : (
          <>
            <CardTitle>Sign in</CardTitle>
            <SignInForm intro="Sign in to open your study data. Signing out never deletes anything saved on this device." />
          </>
        )}
      </Card>
    </div>
  );
}
