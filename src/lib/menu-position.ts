export type Box = { left: number; right: number; top: number; bottom: number };
export type MenuPlacement = {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  side: "below" | "above";
};

/**
 * Where to put a dropdown menu so it stays fully inside the viewport.
 * Pure (all inputs are measurements) so it can be tested at any screen size.
 *
 * - Width: at least the trigger's width, at most the content's natural width,
 *   and never wider than the viewport minus the margins on both sides.
 * - Horizontal: aligned to the trigger's left edge; if that would cross the right
 *   edge it aligns to the trigger's right edge instead; finally clamped to the margins.
 * - Vertical: below the trigger when it fits (or when there is more room below
 *   than above), otherwise above; the menu scrolls if neither side fits it fully.
 */
export function computeMenuPlacement(args: {
  trigger: Box;
  contentWidth: number;
  contentHeight: number;
  viewport: { width: number; height: number };
  margin?: number;
  gap?: number;
}): MenuPlacement {
  const { trigger, contentWidth, contentHeight, viewport, margin = 16, gap = 4 } = args;
  const available = Math.max(0, viewport.width - margin * 2);
  const triggerWidth = trigger.right - trigger.left;
  const width = Math.min(Math.max(triggerWidth, contentWidth), available);

  let left = trigger.left;
  if (left + width > viewport.width - margin) left = trigger.right - width;
  left = Math.max(margin, Math.min(left, viewport.width - margin - width));

  const below = Math.max(0, viewport.height - trigger.bottom - gap - margin);
  const above = Math.max(0, trigger.top - gap - margin);
  const side = contentHeight <= below || below >= above ? "below" : "above";
  const maxHeight = side === "below" ? below : above;
  const height = Math.min(contentHeight, maxHeight);
  const top = side === "below" ? trigger.bottom + gap : trigger.top - gap - height;

  return { left, top, width, maxHeight, side };
}
