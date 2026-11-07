import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Canonical encoding and versioned fingerprints for conflict decision points (M4.3 S5).
 *
 * A fingerprint names the exact situation a user decided about. A stored decision applies only if the
 * same situation is detected again, so it must be:
 *  - deterministic across devices and reloads: no dependence on object insertion order, locale, time or
 *    revisions; only strings, safe integers, booleans, null, arrays and plain objects are encodable
 *  - sensitive to everything that affects the available choices (the callers decide what goes in)
 *  - able to tell a missing value from an explicit `null` (see `tri`)
 *  - versioned: the `sf1:` prefix says how the canonical text was built, so a future format (`sf2:`)
 *    makes every old decision stale instead of silently matching something different
 *
 * The hash is SHA-256 from `@noble/hashes` (vetted library, nothing custom). Fingerprints are not secrets;
 * the hash only gives a short, collision-resistant name for a potentially large canonical text.
 */

export const FINGERPRINT_VERSION = "sf1";

/** A value that may not exist on a side, encoded so "absent" and `null` stay different. */
export type Tri<T> = { t: "absent" } | { t: "value"; v: T };
export const tri = <T>(value: T | undefined): Tri<T> => (value === undefined ? { t: "absent" } : { t: "value", v: value });

const MAX_DEPTH = 64;

/** UTF-16 code-unit order, the same on every device (never `localeCompare`). */
export const compareCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function encode(value: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError("canonicalize: value is nested too deeply");
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value); // well-formed JSON.stringify escapes lone surrogates, so this is deterministic
    case "number":
      if (!Number.isSafeInteger(value)) throw new TypeError("canonicalize: numbers must be safe integers");
      return String(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map((v) => encode(v, depth + 1)).join(",") + "]";
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError("canonicalize: only plain objects are allowed");
      if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("canonicalize: symbol keys are not allowed");
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareCodeUnits);
      const parts = keys.map((k) => {
        const v = record[k];
        // A property that is `undefined` would silently vanish from JSON; refuse it so absence is always explicit.
        if (v === undefined) throw new TypeError(`canonicalize: property "${k}" is undefined (omit it, or use tri())`);
        return JSON.stringify(k) + ":" + encode(v, depth + 1);
      });
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new TypeError(`canonicalize: a ${typeof value} cannot be encoded`);
  }
}

/** The canonical text of a JSON-like value: object keys sorted by code unit, array order kept, no whitespace. */
export function canonicalize(value: unknown): string {
  return encode(value, 0);
}

const HEX = "0123456789abcdef";

/** SHA-256 of the UTF-8 bytes of `text`, as 64 lowercase hex characters. */
export function sha256Hex(text: string): string {
  const digest = sha256(new TextEncoder().encode(text));
  let out = "";
  for (const byte of digest) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

/** `sf1:` + SHA-256 of the canonical text of `{ v: "sf1", p: payload }`. */
export function fingerprintOf(payload: unknown): string {
  return `${FINGERPRINT_VERSION}:${sha256Hex(canonicalize({ v: FINGERPRINT_VERSION, p: payload }))}`;
}

/** Splits `sfN:<64 hex>`; null when the text is not in that shape at all. */
export function parseFingerprint(text: unknown): { version: string; digest: string } | null {
  if (typeof text !== "string") return null;
  const m = /^(sf[0-9]+):([0-9a-f]{64})$/.exec(text);
  return m ? { version: m[1], digest: m[2] } : null;
}
