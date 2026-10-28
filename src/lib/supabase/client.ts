import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client. Uses only the project URL and the public (anon / publishable)
 * key: what a signed-in user may do is decided by Row Level Security and their JWT, never
 * by this key. The service-role key must never appear in this app.
 *
 * Returns null when the project isn't configured, so the app keeps working locally.
 */
export function createSupabaseClient(url: string | undefined, anonKey: string | undefined): SupabaseClient | null {
  if (!url?.trim() || !anonKey?.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  // Plain http is only for a local `supabase start` stack.
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) return null;

  return createClient(parsed.origin, anonKey.trim(), {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // No email-link flows exist (sign-in is email + password), so never read a session from the URL.
      detectSessionInUrl: false,
    },
  });
}

let cached: SupabaseClient | null | undefined;

/** The app-wide client, created on first use from the NEXT_PUBLIC_* variables. */
export function getSupabase(): SupabaseClient | null {
  if (cached === undefined) {
    // Literal property access: Next only inlines NEXT_PUBLIC_* variables written this way.
    cached = createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  }
  return cached;
}
