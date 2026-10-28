import { describe, expect, it } from "vitest";
import { createSupabaseClient } from "@/lib/supabase/client";

const KEY = "public-anon-key";

describe("createSupabaseClient", () => {
  it("returns null (local-only app) when the URL or key is missing or blank", () => {
    expect(createSupabaseClient(undefined, undefined)).toBeNull();
    expect(createSupabaseClient("https://abc.supabase.co", undefined)).toBeNull();
    expect(createSupabaseClient(undefined, KEY)).toBeNull();
    expect(createSupabaseClient("  ", KEY)).toBeNull();
    expect(createSupabaseClient("https://abc.supabase.co", "  ")).toBeNull();
  });

  it("rejects a malformed URL or plain http to a remote host", () => {
    expect(createSupabaseClient("not a url", KEY)).toBeNull();
    expect(createSupabaseClient("http://abc.supabase.co", KEY)).toBeNull();
    expect(createSupabaseClient("ftp://localhost", KEY)).toBeNull();
  });

  it("accepts https, and http only for localhost", () => {
    expect(createSupabaseClient("https://abc.supabase.co", KEY)).not.toBeNull();
    expect(createSupabaseClient("http://127.0.0.1:54321", KEY)).not.toBeNull();
    expect(createSupabaseClient("http://localhost:54321", KEY)).not.toBeNull();
  });
});
