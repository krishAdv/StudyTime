import { normalizeName } from "../class-rules";

/**
 * Text rules shared by the sync modules. They describe what PostgreSQL can store and how it
 * measures text, so both the eligibility check and the response validators agree with the server.
 */

/** PostgreSQL's char_length counts characters (code points), not UTF-16 units. */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}

/** NUL (U+0000) and lone surrogates cannot be stored in PostgreSQL text or jsonb. */
export const hasUnstorableText = (s: string) => s.includes("\u0000") || hasLoneSurrogate(s);

/**
 * A second duplicate-name key: a one-to-one lowercase per character (a character whose lowercase
 * form expands to several characters keeps only the first, like a locale's simple case mapping).
 * Used alongside the app's own `nameKey`, so two names count as duplicates if EITHER rule makes them equal.
 */
export function simpleNameKey(name: string): string {
  let out = "";
  for (const ch of Array.from(normalizeName(name))) {
    out += String.fromCodePoint(ch.toLowerCase().codePointAt(0) ?? ch.codePointAt(0) ?? 0);
  }
  return out;
}
