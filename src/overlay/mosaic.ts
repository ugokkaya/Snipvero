// Turns a blur annotation into a canvas of mosaic pixels cut from the frozen frame. Used by the
// on-screen layer and the export rasterizer alike (see pixelate.ts).

import type { Point, Rect } from "./coords";
import { pixelate } from "./pixelate";

/** A mosaic ready to draw: `x` and `y` are in annotation coordinates (relative to the origin). */
export interface MosaicPatch {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
}

/** The whole-pixel area of `rect` (annotation coordinates) inside a `width`×`height` frame. */
export function frameArea(rect: Rect, origin: Point, width: number, height: number): Rect | null {
  const left = Math.max(0, Math.floor(rect.x + origin.x));
  const top = Math.max(0, Math.floor(rect.y + origin.y));
  const right = Math.min(width, Math.ceil(rect.x + rect.width + origin.x));
  const bottom = Math.min(height, Math.ceil(rect.y + rect.height + origin.y));
  return right > left && bottom > top
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : null;
}

/**
 * Pixelates the part of `source` (the frame, at its native size) that `rect` covers. Null when
 * nothing of it is on the frame. Throws when canvases are unavailable.
 */
export function mosaicPatch(
  source: HTMLCanvasElement,
  rect: Rect,
  block: number,
  origin: Point,
): MosaicPatch | null {
  const area = frameArea(rect, origin, source.width, source.height);
  if (!area) return null;
  // A mosaic that cannot be made must fail loudly: skipping it would export the unhidden pixels.
  const from = source.getContext("2d");
  const canvas = document.createElement("canvas");
  canvas.width = area.width;
  canvas.height = area.height;
  const to = canvas.getContext("2d");
  if (!from || !to) throw new Error("could not blur the selected area");
  const image = from.getImageData(area.x, area.y, area.width, area.height);
  const pixels = pixelate(image.data, area.width, area.height, block);
  to.putImageData(new ImageData(pixels, area.width, area.height), 0, 0);
  return { canvas, x: area.x - origin.x, y: area.y - origin.y };
}
