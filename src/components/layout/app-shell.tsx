"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "./nav-items";
import { MiniTimer } from "@/features/timer/mini-timer";

const noopSubscribe = () => () => {};

/** True only after hydration, so saved data is never rendered on the server. */
function useMounted() {
  return useSyncExternalStore(noopSubscribe, () => true, () => false);
}

function useIsActive() {
  const pathname = usePathname();
  return (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));
}

function Brand() {
  return (
    <Link href="/" className="flex items-center gap-2.5 rounded-lg">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <Timer className="h-5 w-5" aria-hidden />
      </span>
      <span className="text-lg font-semibold tracking-tight">StudyTime</span>
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const isActive = useIsActive();
  const mounted = useMounted();

  return (
    <div className="min-h-dvh md:flex">
      {/* Sidebar: tablet and up */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border px-4 py-6 md:flex">
        <div className="px-2">
          <Brand />
        </div>
        <nav aria-label="Main" className="mt-8 flex flex-col gap-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              aria-current={isActive(href) ? "page" : undefined}
              className={cn(
                "flex h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors",
                isActive(href)
                  ? "bg-primary-soft text-primary"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              <Icon className="h-5 w-5" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
        <p className="mt-auto px-3 text-xs text-muted-foreground">Saved on this device only</p>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: phones */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/90 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] backdrop-blur md:hidden">
          <Brand />
        </header>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 pb-[calc(env(safe-area-inset-bottom)+6rem)] pt-6 sm:px-6 md:pb-12 md:pt-10 lg:px-10">
          {mounted ? (
            children
          ) : (
            <p className="py-24 text-center text-sm text-muted-foreground" role="status">
              Loading…
            </p>
          )}
        </main>
      </div>

      {/* Running-timer pill on phones when away from the dashboard */}
      <MiniTimer />

      {/* Bottom tab bar: phones */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={isActive(href) ? "page" : undefined}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium",
              isActive(href) ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden />
            {label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
