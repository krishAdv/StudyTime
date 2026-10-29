"use client";

import { useMemo } from "react";
import { SignInWall } from "@/features/auth/sign-in-wall";
import { useAuth } from "@/features/auth/auth-provider";
import { TimerProvider } from "@/features/timer/timer-provider";
import { createAccountStore } from "@/lib/account-store";
import { localStorageStore, type StorageLike, type StudyDataStore } from "@/lib/data-store";
import { StudyDataProvider } from "./study-data-provider";

/**
 * Decides which study data the app is allowed to show, and mounts the data and timer
 * providers for exactly that owner.
 *
 *  - Supabase not configured (`disabled`): the legacy device bucket, as before accounts existed.
 *  - `loading` / `signed-out`: the sign-in wall, no data provider at all, so no study data
 *    (any account's, or the legacy bucket) is read or rendered.
 *  - `signed-in`: that account's own bucket. The scope is keyed by user id, so a different
 *    user remounts StudyDataProvider and TimerProvider: no state, in-flight timer or pending
 *    write can carry over, and a running timer can only ever be saved by the provider
 *    instance that started it (the same account).
 *
 * Nothing here deletes or rewrites any stored key.
 */
export function AccountBoundary({
  children,
  legacyStore = localStorageStore,
  getStorage,
}: {
  children: React.ReactNode;
  /** The pre-accounts store, used only when accounts aren't configured. Tests inject a fake. */
  legacyStore?: StudyDataStore;
  /** Storage for account buckets; defaults to window.localStorage. Tests inject a fake. */
  getStorage?: () => StorageLike | null;
}) {
  const { status, user } = useAuth();

  if (status === "disabled") {
    return (
      <StudyDataProvider key="local" store={legacyStore}>
        <TimerProvider>{children}</TimerProvider>
      </StudyDataProvider>
    );
  }
  if (status === "signed-in" && user) {
    return (
      <AccountScope key={`user:${user.id}`} userId={user.id} getStorage={getStorage}>
        {children}
      </AccountScope>
    );
  }
  return <SignInWall checking={status === "loading"} />;
}

function AccountScope({
  userId,
  getStorage,
  children,
}: {
  userId: string;
  getStorage?: () => StorageLike | null;
  children: React.ReactNode;
}) {
  // StudyDataProvider expects a stable store; the key above already remounts per user.
  const store = useMemo(() => createAccountStore(userId, getStorage), [userId, getStorage]);
  return (
    <StudyDataProvider store={store}>
      <TimerProvider>{children}</TimerProvider>
    </StudyDataProvider>
  );
}
