import type { Placement, Rect } from './types';

export interface Size {
  width: number;
  height: number;
}

export interface Position {
  top: number;
  left: number;
  /** The side actually used after any flip; "center" when there is nothing to point at or the sheet is used. */
  placement: 'top' | 'bottom' | 'left' | 'right' | 'center' | 'sheet';
}

/** Below this viewport width the tooltip becomes a bottom sheet. */
export const SHEET_MAX_WIDTH = 640;

/**
 * Where to put the tooltip so it stays inside the viewport. The preferred side is tried first, then the opposite side, then
 * the remaining sides; if nothing fits it is clamped into view. `target` is in viewport coordinates.
 */
export function computePosition(target: Rect | null, tip: Size, view: Size, pref: Placement = 'auto', gap = 12, margin = 12): Position {
  if (view.width <= SHEET_MAX_WIDTH) {
    return { top: Math.max(margin, view.height - tip.height - margin), left: margin, placement: 'sheet' };
  }
  if (!target) {
    return { top: Math.max(margin, (view.height - tip.height) / 2), left: Math.max(margin, (view.width - tip.width) / 2), placement: 'center' };
  }
  const room = {
    top: target.top - gap - margin,
    bottom: view.height - (target.top + target.height) - gap - margin,
    left: target.left - gap - margin,
    right: view.width - (target.left + target.width) - gap - margin,
  };
  const fits = (side: 'top' | 'bottom' | 'left' | 'right'): boolean => (side === 'top' || side === 'bottom' ? room[side] >= tip.height : room[side] >= tip.width);
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const;
  const first = pref === 'auto' ? (room.bottom >= room.top ? 'bottom' : 'top') : pref;
  const order = [first, opposite[first], ...(['bottom', 'top', 'right', 'left'] as const).filter((s) => s !== first && s !== opposite[first])];
  const side = order.find(fits) ?? order.reduce((a, b) => ((room[b] > room[a]) ? b : a));

  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  let top: number;
  let left: number;
  if (side === 'top') {
    top = target.top - gap - tip.height;
    left = cx - tip.width / 2;
  } else if (side === 'bottom') {
    top = target.top + target.height + gap;
    left = cx - tip.width / 2;
  } else if (side === 'left') {
    top = cy - tip.height / 2;
    left = target.left - gap - tip.width;
  } else {
    top = cy - tip.height / 2;
    left = target.left + target.width + gap;
  }
  return {
    top: Math.min(Math.max(margin, top), Math.max(margin, view.height - tip.height - margin)),
    left: Math.min(Math.max(margin, left), Math.max(margin, view.width - tip.width - margin)),
    placement: side,
  };
}
