import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize, compareCodeUnits, fingerprintOf, parseFingerprint, sha256Hex, tri } from "@/lib/sync/fingerprint";

describe("sha256Hex (known answers)", () => {
  it("matches the NIST FIPS 180-4 example vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    expect(sha256Hex("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  });

  it("agrees with Node's own SHA-256 on multi-byte text, surrogate pairs and long input", () => {
    const samples = ["é", "日本語のテキスト", "😀", "a😀b", "\u0000", "line\nbreak\r\n", "x".repeat(100_000), "é".repeat(5_000), "\ud800"];
    for (const text of samples) expect(sha256Hex(text), JSON.stringify(text.slice(0, 20))).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
  });

  it("always gives 64 lowercase hex characters", () => {
    for (const text of ["", "a", "ab".repeat(77)]) expect(sha256Hex(text)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the dependency", () => {
  it("is pinned to the exact approved version, installed at that version", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.dependencies["@noble/hashes"]).toBe("2.4.0");
    const installed = JSON.parse(readFileSync("node_modules/@noble/hashes/package.json", "utf8"));
    expect(installed.version).toBe("2.4.0");
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    expect(lock.packages["node_modules/@noble/hashes"].version).toBe("2.4.0");
    expect(lock.packages["node_modules/@noble/hashes"].integrity).toMatch(/^sha512-/);
  });

  it("is imported in exactly one source file, and only `sha256` is imported", () => {
    const hits: { file: string; line: string }[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|js|mjs)$/.test(name)) {
          for (const line of readFileSync(path, "utf8").split("\n")) if (line.includes("@noble/hashes")) hits.push({ file: path.replace(/\\/g, "/"), line: line.trim() });
        }
      }
    };
    walk("src");
    const imports = hits.filter((h) => /^\s*import\b/.test(h.line));
    expect(imports).toEqual([{ file: "src/lib/sync/fingerprint.ts", line: 'import { sha256 } from "@noble/hashes/sha2.js";' }]);
  });
});

describe("canonicalize", () => {
  it("does not depend on object key insertion order, at any depth", () => {
    const a = { b: 1, a: { y: [1, { q: 1, p: 2 }], x: "s" } };
    const b = { a: { x: "s", y: [1, { p: 2, q: 1 }] }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"a":{"x":"s","y":[1,{"p":2,"q":1}]},"b":1}');
  });

  it("keeps array order", () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
    expect(canonicalize(["b", "a"])).toBe('["b","a"]');
  });

  it("sorts keys by UTF-16 code unit, not by locale and not by code point", () => {
    const keys = ["b", "B", "a", "A", "é", "z", "10", "9"];
    const encoded = canonicalize(Object.fromEntries(keys.map((k) => [k, 0])));
    expect(encoded).toBe('{"10":0,"9":0,"A":0,"B":0,"a":0,"b":0,"z":0,"é":0}');
    // U+1F600 is the surrogate pair D83D DE00, which sorts BEFORE U+FFFF by code unit (it would sort after by code point).
    expect(compareCodeUnits("\u{1F600}", "\uFFFF")).toBeLessThan(0);
    expect(canonicalize({ "\uFFFF": 1, "\u{1F600}": 2 })).toBe('{"😀":2,"\uFFFF":1}');
    // numeric-looking keys are strings, not array indexes: "10" sorts before "9"
    expect(canonicalize({ 9: 1, 10: 2 })).toBe('{"10":2,"9":1}');
  });

  it("encodes own keys named like Object.prototype members, including __proto__, without touching any prototype", () => {
    const fromJson = JSON.parse('{"__proto__":1,"constructor":2,"toString":3}'); // own keys, as when read back from text
    expect(canonicalize(fromJson)).toBe('{"__proto__":1,"constructor":2,"toString":3}');
    const dict = Object.create(null) as Record<string, number>; // a null-prototype dictionary, as decisions.ts uses
    dict["toString"] = 3;
    dict["__proto__"] = 1; // an ordinary own key here
    dict["constructor"] = 2;
    expect(Object.keys(dict)).toEqual(["toString", "__proto__", "constructor"]);
    expect(canonicalize(dict)).toBe('{"__proto__":1,"constructor":2,"toString":3}');
    expect(canonicalize(dict)).toBe(canonicalize(fromJson)); // the same text whichever way the object was built
    expect(fingerprintOf({ d: dict })).toBe(fingerprintOf({ d: fromJson }));
    // An ordinary object that assigns "__proto__" has its PROTOTYPE replaced, not a key added. The encoder refuses such an object
    // instead of dropping the key; this is what used to make merge3 throw, and why decisions.ts builds its context on dictionaries.
    const plain: Record<string, unknown> = {};
    plain["__proto__"] = { x: 1 };
    expect(Object.keys(plain)).toEqual([]);
    expect(() => canonicalize(plain)).toThrow(TypeError);
  });

  it("tells an absent property from an explicit null, and null from an absent top-level value", () => {
    expect(canonicalize({})).not.toBe(canonicalize({ a: null }));
    expect(canonicalize({ a: null })).toBe('{"a":null}');
    expect(canonicalize(tri(undefined))).not.toBe(canonicalize(tri(null)));
    expect(canonicalize(tri(undefined))).toBe('{"t":"absent"}');
    expect(canonicalize(tri(null))).toBe('{"t":"value","v":null}');
    expect(canonicalize(tri(""))).not.toBe(canonicalize(tri(undefined)));
    expect(canonicalize(tri(0))).not.toBe(canonicalize(tri(undefined)));
  });

  it("refuses a property that is undefined instead of silently dropping it", () => {
    expect(() => canonicalize({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalize([undefined])).toThrow(TypeError);
    expect(() => canonicalize(undefined)).toThrow(TypeError);
  });

  it("refuses values it cannot encode the same way everywhere", () => {
    for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, BigInt(1), () => 1, Symbol("s"), new Date(0), new Map(), new (class X {})(), { [Symbol("k")]: 1 }]) {
      expect(() => canonicalize(bad), String(typeof bad)).toThrow(TypeError);
    }
  });

  it("refuses values nested too deeply", () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(TypeError);
  });

  it("encodes strings and integers exactly", () => {
    expect(canonicalize('he said "hi"\n')).toBe('"he said \\"hi\\"\\n"');
    expect(canonicalize(-5)).toBe("-5");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize("\ud800")).toBe('"\\ud800"'); // a lone surrogate is escaped, so it encodes the same on every device
  });
});

describe("fingerprintOf", () => {
  it("has the sf1: format and is deterministic", () => {
    const f = fingerprintOf({ a: 1, b: [1, 2] });
    expect(f).toMatch(/^sf1:[0-9a-f]{64}$/);
    expect(fingerprintOf({ b: [1, 2], a: 1 })).toBe(f);
    expect(fingerprintOf(JSON.parse(JSON.stringify({ a: 1, b: [1, 2] })))).toBe(f);
  });

  it("is the SHA-256 of the canonical versioned payload (so the format is exactly specified)", () => {
    expect(fingerprintOf({ a: 1 })).toBe("sf1:" + createHash("sha256").update('{"p":{"a":1},"v":"sf1"}', "utf8").digest("hex"));
  });

  it("changes with any change to the payload, including absent versus null", () => {
    const seen = new Set([
      fingerprintOf({ a: 1 }), fingerprintOf({ a: 2 }), fingerprintOf({ a: 1, b: 1 }), fingerprintOf({ a: [1] }), fingerprintOf({ a: [1, 2] }),
      fingerprintOf({ a: null }), fingerprintOf({}), fingerprintOf({ a: tri(undefined) }), fingerprintOf({ a: tri(null) }), fingerprintOf([]),
    ]);
    expect(seen.size).toBe(10);
  });

  it("parseFingerprint accepts only the sfN:<64 lowercase hex> shape", () => {
    const hex = "a".repeat(64);
    expect(parseFingerprint(`sf1:${hex}`)).toEqual({ version: "sf1", digest: hex });
    expect(parseFingerprint(`sf2:${hex}`)).toEqual({ version: "sf2", digest: hex });
    for (const bad of ["", "sf1:", `sf1:${hex.slice(1)}`, `sf1:${hex}0`, `SF1:${hex}`, `sf1:${"A".repeat(64)}`, `xx1:${hex}`, `sf:${hex}`, ` sf1:${hex}`, null, 5, undefined, {}]) {
      expect(parseFingerprint(bad), String(bad)).toBeNull();
    }
  });
});
