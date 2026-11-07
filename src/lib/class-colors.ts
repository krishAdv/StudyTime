/**
 * Class colors. A class color is always a 6-digit hex string (`#rrggbb`): the same rule the export
 * format (`data-export.ts`), sync eligibility and the database check (`classes_color_check`) enforce.
 *
 * The first six presets are the colors the app assigned automatically before colors could be chosen,
 * in the same order, so existing classes keep matching a preset. Colors are only used as accents
 * (bars, dots, swatches) next to normal text, never as a text background, so text contrast does not
 * depend on them; mid-tone (Tailwind 500) shades stay visible on both the light and dark card colors.
 */

export type ClassColorOption = { value: string; name: string };

export const CLASS_COLOR_OPTIONS: readonly ClassColorOption[] = [
  { value: "#3b82f6", name: "Blue" },
  { value: "#8b5cf6", name: "Violet" },
  { value: "#f59e0b", name: "Amber" },
  { value: "#10b981", name: "Emerald" },
  { value: "#ec4899", name: "Pink" },
  { value: "#14b8a6", name: "Teal" },
  { value: "#ef4444", name: "Red" },
  { value: "#f97316", name: "Orange" },
  { value: "#84cc16", name: "Lime" },
  { value: "#0ea5e9", name: "Sky" },
  { value: "#6366f1", name: "Indigo" },
  { value: "#64748b", name: "Slate" },
];

export const CLASS_COLORS: readonly string[] = CLASS_COLOR_OPTIONS.map((o) => o.value);

const HEX6 = /^#[0-9a-fA-F]{6}$/;
const HEX3 = /^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/;

/** True for a color the app, the export format and the database all accept. */
export const isClassColor = (v: unknown): v is string => typeof v === "string" && HEX6.test(v);

/** Display name of a preset color, or null for any other valid color. */
export function colorName(color: string): string | null {
  const key = color.toLowerCase();
  return CLASS_COLOR_OPTIONS.find((o) => o.value === key)?.name ?? null;
}

/**
 * Color for a new class: the first preset no existing class uses, so new classes stand apart;
 * once every preset is taken, presets repeat in order.
 */
export function defaultClassColor(existing: readonly { color: string }[]): string {
  const used = new Set(existing.map((c) => c.color.toLowerCase()));
  return CLASS_COLORS.find((c) => !used.has(c)) ?? CLASS_COLORS[existing.length % CLASS_COLORS.length];
}

/**
 * Color read from stored data: a valid `#rrggbb` is kept exactly; `#rgb` is expanded (same look);
 * anything else (missing, empty, a CSS name) falls back to the preset for the class's position.
 */
export function normalizeStoredColor(v: unknown, index: number): string {
  if (isClassColor(v)) return v;
  const short = typeof v === "string" ? HEX3.exec(v) : null;
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return CLASS_COLORS[index % CLASS_COLORS.length];
}

/** Black or white, whichever is more readable on top of `color` (WCAG relative luminance). */
export function contrastingInk(color: string): "#000000" | "#ffffff" {
  if (!isClassColor(color)) return "#ffffff";
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  // Contrast with white is 1.05/(l+0.05); with black (l+0.05)/0.05. Pick the larger.
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? "#ffffff" : "#000000";
}
