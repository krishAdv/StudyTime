import { describe, expect, it } from "vitest";
import { PRODUCTION_REF, TEST_REF, checkApp, refFromUrl } from "../scripts/lib/project-guard";

/** The verification scripts' production guard. Pure configuration checks: nothing here connects to anything. */
describe("refFromUrl", () => {
  it("accepts exactly the bare project URL", () => {
    expect(refFromUrl(`https://${TEST_REF}.supabase.co`)).toBe(TEST_REF);
    expect(refFromUrl(`https://${PRODUCTION_REF}.supabase.co`)).toBe(PRODUCTION_REF); // read, then refused by the checks
    expect(refFromUrl(`https://${TEST_REF}.supabase.co/`)).toBe(TEST_REF); // a lone trailing slash is the same URL
  });

  it("refuses a path, a query string and a fragment", () => {
    expect(refFromUrl(`https://${TEST_REF}.supabase.co/rest/v1`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co/rest/v1/`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co/?x=1`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co?x=1`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co/#frag`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co#frag`)).toBeNull();
  });

  it("refuses an empty query or fragment marker (the parser reports both as empty)", () => {
    expect(refFromUrl(`https://${TEST_REF}.supabase.co?`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co/?`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co#`)).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.supabase.co/#`)).toBeNull();
  });

  it("still refuses every earlier invalid form", () => {
    expect(refFromUrl(undefined)).toBeNull();
    expect(refFromUrl("")).toBeNull();
    expect(refFromUrl("not a url")).toBeNull();
    expect(refFromUrl(`${TEST_REF}.supabase.co`)).toBeNull(); // no scheme
    expect(refFromUrl(`http://${TEST_REF}.supabase.co`)).toBeNull(); // not https
    expect(refFromUrl(`https://${TEST_REF}.supabase.co:443`)).toBeNull(); // a port, even the default one written out (the parser hides it, the raw text check catches it)
    expect(refFromUrl(`https://${TEST_REF}.supabase.co:8443`)).toBeNull();
    expect(refFromUrl(`HTTPS://${TEST_REF.toUpperCase()}.SUPABASE.CO`)).toBeNull(); // not the exact lowercase form
    expect(refFromUrl(`https://user@${TEST_REF}.supabase.co`)).toBeNull(); // credentials
    expect(refFromUrl(`https://user:pw@${TEST_REF}.supabase.co`)).toBeNull();
    expect(refFromUrl("http://localhost:54321")).toBeNull();
    expect(refFromUrl("https://localhost")).toBeNull();
    expect(refFromUrl(`https://${TEST_REF}.example.com`)).toBeNull(); // not supabase.co
    expect(refFromUrl(`https://api.${TEST_REF}.supabase.co`)).toBeNull(); // another subdomain
    expect(refFromUrl(`https://${TEST_REF}.supabase.co.evil.test`)).toBeNull();
    expect(refFromUrl("https://short.supabase.co")).toBeNull(); // not a 20-character reference
    expect(refFromUrl(`https://${TEST_REF}x.supabase.co`)).toBeNull();
  });
});

describe("checkApp uses the stricter URL check", () => {
  const key = "sb_publishable_fake";
  const base = { NEXT_PUBLIC_SUPABASE_ANON_KEY: key, STAGE_CONFIRM_PROJECT: TEST_REF };
  const noRepo = { cwd: "C:/does-not-exist-for-this-test" };

  it("passes for the bare test URL", () => {
    expect(checkApp({ ...base, NEXT_PUBLIC_SUPABASE_URL: `https://${TEST_REF}.supabase.co` }, { requireConfirm: true, ...noRepo }).ok).toBe(true);
  });

  it("refuses the test URL once a path, query or fragment is attached", () => {
    for (const suffix of ["/rest/v1", "?x=1", "#frag", "?", "#"]) {
      const r = checkApp({ ...base, NEXT_PUBLIC_SUPABASE_URL: `https://${TEST_REF}.supabase.co${suffix}` }, { requireConfirm: true, ...noRepo });
      expect(r.ok, suffix).toBe(false);
      expect(r.ref, suffix).toBeNull();
    }
  });

  it("still refuses production, another project and a missing URL", () => {
    expect(checkApp({ ...base, NEXT_PUBLIC_SUPABASE_URL: `https://${PRODUCTION_REF}.supabase.co` }, noRepo).ok).toBe(false);
    expect(checkApp({ ...base, NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }, noRepo).ok).toBe(false);
    expect(checkApp({ ...base }, noRepo).ok).toBe(false);
  });
});
