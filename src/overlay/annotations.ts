// Annotation data and geometry, independent of React, Konva and the DOM.
//
// Annotations are plain serializable objects. Coordinates and sizes are in the frame's physical
// pixels, relative to the selected region's top-left corner (see editor.ts), so export can
// draw them onto the cropped region without further conversion. Values need not be integers.

import { clamp, type Point, type Rect, type Size } from "./coords";

export type Tool = "select" | "arrow" | "rect" | "text";
export type SizeLevel = 0 | 1 | 2;

export interface Style {
  color: string;
  size: SizeLevel;
}

export const COLORS = ["#ff3b30", "#ffcc00", "#34c759", "#0a84ff", "#000000", "#ffffff"] as const;
export const DEFAULT_STYLE: Style = { color: COLORS[0], size: 1 };

/** Size presets in CSS pixels, so a stroke looks the same on every display. */
const STROKE_CSS = [2, 4, 8] as const;
const FONT_CSS = [14, 20, 32] as const;

/** Line height as a multiple of the font size, shared by the canvas text and the textarea. */
export const LINE_HEIGHT = 1.25;
export const FONT_FAMILY = 'system-ui, "Segoe UI", sans-serif';

export interface ArrowAnnotation {
  kind: "arrow";
  id: number;
  color: string;
  /** Stroke width in frame pixels. */
  width: number;
  from: Point;
  to: Point;
}

export interface RectAnnotation {
  kind: "rect";
  id: number;
  color: string;
  width: number;
  /** The rectangle the stroke is centered on. Outlined only (no fill). */
  rect: Rect;
}

export interface TextAnnotation {
  kind: "text";
  id: number;
  color: string;
  /** Font size in frame pixels. */
  fontSize: number;
  /** Top-left corner of the first line box. */
  at: Point;
  text: string;
}

export type Annotation = ArrowAnnotation | RectAnnotation | TextAnnotation;

/** Width of one line of text at `fontSize`, in the same units. Injected so tests need no canvas. */
export type MeasureLine = (line: string, fontSize: number) => number;

/** Frame pixels per CSS pixel; never below one device pixel. */
export const strokeWidth = (size: SizeLevel, scale: number) =>
  Math.max(1, Math.round(STROKE_CSS[size] * scale));
export const fontSize = (size: SizeLevel, scale: number) => Math.round(FONT_CSS[size] * scale);

/** Applies a style to an annotation, or returns the same object if nothing changes. */
export function withStyle(a: Annotation, style: Style, scale: number): Annotation {
  if (a.kind === "text") {
    const size = fontSize(style.size, scale);
    return a.color === style.color && a.fontSize === size
      ? a
      : { ...a, color: style.color, fontSize: size };
  }
  const width = strokeWidth(style.size, scale);
  return a.color === style.color && a.width === width ? a : { ...a, color: style.color, width };
}

/** The style preset closest to an annotation, so selecting it shows its colour and size. */
export function styleOf(a: Annotation, scale: number): Style {
  const value = a.kind === "text" ? a.fontSize : a.width;
  const distance = (level: SizeLevel) =>
    Math.abs((a.kind === "text" ? fontSize(level, scale) : strokeWidth(level, scale)) - value);
  const size = ([1, 2] as const).reduce<SizeLevel>(
    (best, level) => (distance(level) < distance(best) ? level : best),
    0,
  );
  return { color: a.color, size };
}

export interface ArrowGeometry {
  /** Line from the tail to the base of the head: x1, y1, x2, y2. */
  shaft: [number, number, number, number];
  /** Closed triangle: tip, then the two barbs. */
  head: [number, number, number, number, number, number];
}

/**
 * The shaft ends inside the head, so a thick stroke neither pokes past the tip nor leaves a gap.
 * The head scales with the stroke and shrinks to fit a short arrow.
 */
export function arrowGeometry({ from, to, width }: ArrowAnnotation): ArrowGeometry {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  const ux = length > 0 ? dx / length : 1;
  const uy = length > 0 ? dy / length : 0;
  const headLength = Math.min(length, width * 3 + 6);
  const halfWidth = headLength * 0.6;
  const base = { x: to.x - ux * headLength, y: to.y - uy * headLength };
  const shaftEnd = { x: to.x - ux * headLength * 0.5, y: to.y - uy * headLength * 0.5 };
  return {
    shaft: [from.x, from.y, shaftEnd.x, shaftEnd.y],
    head: [
      to.x,
      to.y,
      base.x - uy * halfWidth,
      base.y + ux * halfWidth,
      base.x + uy * halfWidth,
      base.y - ux * halfWidth,
    ],
  };
}

export function textSize(text: string, size: number, measure: MeasureLine): Size {
  const lines = text.split("\n");
  return {
    width: Math.max(0, ...lines.map((line) => measure(line, size))),
    height: lines.length * size * LINE_HEIGHT,
  };
}

const grow = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  width: r.width + 2 * by,
  height: r.height + 2 * by,
});

const contains = (r: Rect, p: Point) =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

/** The area an annotation covers, including its stroke. */
export function annotationBounds(a: Annotation, measure: MeasureLine): Rect {
  switch (a.kind) {
    case "arrow": {
      const [, , ax, ay, bx, by] = arrowGeometry(a).head;
      const xs = [a.from.x, a.to.x, ax, bx];
      const ys = [a.from.y, a.to.y, ay, by];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return grow({ x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }, a.width / 2);
    }
    case "rect":
      return grow(a.rect, a.width / 2);
    case "text":
      return { ...a.at, ...textSize(a.text, a.fontSize, measure) };
  }
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Whether a press at `p` grabs `a`, within `tolerance` pixels. Outlined rectangles are grabbed by
 * their border, so the screenshot inside them stays reachable; a text by its whole box.
 */
export function hitsAnnotation(
  a: Annotation,
  p: Point,
  tolerance: number,
  measure: MeasureLine,
): boolean {
  switch (a.kind) {
    case "arrow":
      return distanceToSegment(p, a.from, a.to) <= tolerance + a.width / 2;
    case "rect": {
      const band = tolerance + a.width / 2;
      const inner = grow(a.rect, -band);
      const hollow = inner.width > 0 && inner.height > 0 && contains(inner, p);
      return contains(grow(a.rect, band), p) && !hollow;
    }
    case "text":
      return contains(grow(annotationBounds(a, measure), tolerance), p);
  }
}

/** The topmost (last drawn) annotation at `p`. */
export function annotationAt(
  list: readonly Annotation[],
  p: Point,
  tolerance: number,
  measure: MeasureLine,
): Annotation | null {
  return [...list].reverse().find((a) => hitsAnnotation(a, p, tolerance, measure)) ?? null;
}

export function translate(a: Annotation, dx: number, dy: number): Annotation {
  if (dx === 0 && dy === 0) return a;
  const shift = (p: Point) => ({ x: p.x + dx, y: p.y + dy });
  switch (a.kind) {
    case "arrow":
      return { ...a, from: shift(a.from), to: shift(a.to) };
    case "rect":
      return { ...a, rect: { ...a.rect, ...shift(a.rect) } };
    case "text":
      return { ...a, at: shift(a.at) };
  }
}
