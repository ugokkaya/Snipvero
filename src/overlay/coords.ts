// Coordinate conversions for one overlay window. Pure, so HiDPI math is tested without a webview.
//
// Spaces:
// - client: CSS pixels of the overlay window (= logical display units, origin at the display's top-left);
// - pixel: physical pixels of that display's captured frame (integer, origin at the frame's top-left).
// The selection model works in pixel space only, so exported regions need no further conversion.
// The ratio is derived from the frame and window sizes per axis rather than assumed from a scale
// factor, so every display uses its own (possibly fractional) scale.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Point, Size {}

/** Physical pixels per CSS pixel along each axis. */
export function pixelRatio(view: Size, frame: Size): Point {
  return { x: frame.width / view.width, y: frame.height / view.height };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Maps a pointer position to the nearest pixel edge, clamped to the frame. Edges run from 0 to
 * width inclusive, so a selection can reach the last row and column of the display.
 */
export function clientToPixel(point: Point, view: Size, frame: Size): Point {
  const ratio = pixelRatio(view, frame);
  return {
    x: clamp(Math.round(point.x * ratio.x), 0, frame.width),
    y: clamp(Math.round(point.y * ratio.y), 0, frame.height),
  };
}

/** Pixel-space rectangle in CSS pixels, for drawing. */
export function pixelToClient(rect: Rect, view: Size, frame: Size): Rect {
  const ratio = pixelRatio(view, frame);
  return {
    x: rect.x / ratio.x,
    y: rect.y / ratio.y,
    width: rect.width / ratio.x,
    height: rect.height / ratio.y,
  };
}

/** Rectangle spanned by two corners, dragged in any direction. */
export function spanRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/**
 * Places a box of `size` next to `rect` inside `view`: on the preferred side if it fits, else the
 * other side, else inside the rect's bottom edge (a full-height selection). Horizontally aligned with
 * the rect's left edge and kept on screen. Used for the size label and the annotation toolbar (FR-4).
 */
export function placeOutside(
  rect: Rect,
  size: Size,
  view: Size,
  gap: number,
  prefer: "above" | "below",
): Point {
  const above = rect.y - gap - size.height;
  const below = rect.y + rect.height + gap;
  const fits = { above: above >= 0, below: below + size.height <= view.height };
  const other = prefer === "above" ? "below" : "above";
  const side = fits[prefer] ? prefer : fits[other] ? other : null;
  const y =
    side === "above" ? above : side === "below" ? below : rect.y + rect.height - gap - size.height;
  return {
    x: clamp(rect.x, 0, Math.max(0, view.width - size.width)),
    y: clamp(y, 0, Math.max(0, view.height - size.height)),
  };
}

const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Places the size label above `rect` (see `placeOutside`) unless that covers the toolbar, which
 * takes priority: it is then stacked on the toolbar's far side, else just below it.
 */
export function placeLabel(
  rect: Rect,
  size: Size,
  view: Size,
  gap: number,
  toolbar: Rect | null,
): Point {
  const label = placeOutside(rect, size, view, gap, "above");
  if (!toolbar || !overlaps({ ...label, ...size }, toolbar)) return label;
  const above = toolbar.y - gap - size.height;
  const y = above >= 0 ? above : toolbar.y + toolbar.height + gap;
  return { x: label.x, y: clamp(y, 0, Math.max(0, view.height - size.height)) };
}
