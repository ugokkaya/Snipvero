// Region selection model for one overlay, independent of React and the DOM.
//
// All points and rectangles are in the frame's physical pixel space (see coords.ts), so a
// finalized rectangle is already the exported region: integer, non-empty and inside the frame.

import { clamp, pixelRatio, spanRect, type Point, type Rect, type Size } from "./coords";

export type Handle = "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
export type Hit = Handle | "inside" | "outside";

/** The frame a selection lives in, with pointer tolerances already converted to pixels. */
export interface Space extends Size {
  /** Distance from an edge or corner that still grabs it. */
  grab: number;
  /** Pointer travel below which a press is a click rather than a drag. */
  slop: number;
}

/** Pointer tolerances in CSS pixels, so they feel the same at every scale factor. */
const GRAB_CSS = 8;
const SLOP_CSS = 3;

/** The selection space of a frame of `frame` pixels shown in a window of `view` CSS pixels. */
export function spaceFor(view: Size, frame: Size): Space {
  const ratio = pixelRatio(view, frame);
  const scale = Math.max(ratio.x, ratio.y);
  return {
    width: frame.width,
    height: frame.height,
    grab: GRAB_CSS * scale,
    slop: SLOP_CSS * scale,
  };
}

export type SelectionState =
  | { phase: "idle" }
  | { phase: "creating"; anchor: Point; rect: Rect; previous: Rect | null; dragged: boolean }
  | { phase: "selected"; rect: Rect }
  | { phase: "moving"; rect: Rect; origin: Rect; start: Point }
  | { phase: "resizing"; rect: Rect; origin: Rect; start: Point; handle: Handle }
  | { phase: "cancelled" };

export type SelectionAction =
  | { type: "press"; point: Point }
  | { type: "drag"; point: Point }
  | { type: "release" }
  /** Another display took the selection: only one per capture session. */
  | { type: "clear" }
  /** Escape: the capture session ends; ignore any further input. */
  | { type: "cancel" };

export const IDLE: SelectionState = { phase: "idle" };

export function selectionRect(state: SelectionState): Rect | null {
  return "rect" in state ? state.rect : null;
}

/** The finalized region, or null while there is none or it is being edited. */
export function selectedRegion(state: SelectionState): Rect | null {
  return state.phase === "selected" ? state.rect : null;
}

export function isDragging(state: SelectionState): boolean {
  return state.phase === "creating" || state.phase === "moving" || state.phase === "resizing";
}

/**
 * What a press at `point` grabs. Edges and corners extend `grab` outward; inward they take at most
 * a quarter of the side, so even a tiny selection keeps an area in the middle for moving it.
 */
export function hitTest(rect: Rect, point: Point, grab: number): Hit {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (
    point.x < rect.x - grab ||
    point.x > right + grab ||
    point.y < rect.y - grab ||
    point.y > bottom + grab
  ) {
    return "outside";
  }
  const insetX = Math.min(grab, rect.width / 4);
  const insetY = Math.min(grab, rect.height / 4);
  const vertical = point.y <= rect.y + insetY ? "n" : point.y >= bottom - insetY ? "s" : "";
  const horizontal = point.x <= rect.x + insetX ? "w" : point.x >= right - insetX ? "e" : "";
  const handle = `${vertical}${horizontal}`;
  return handle === "" ? "inside" : (handle as Handle);
}

/**
 * `origin` with the edges of `handle` moved by `delta`, kept within `0..bounds`. Dragging an edge
 * past the opposite one flips the rectangle instead of stopping at zero size. Used for the selection
 * and for rectangle annotations.
 */
export function resizeRect(origin: Rect, handle: Handle, delta: Point, bounds: Size): Rect {
  const edge = (value: number, moves: boolean, d: number, max: number) =>
    moves ? clamp(value + d, 0, max) : value;
  const corner1 = {
    x: edge(origin.x, handle.includes("w"), delta.x, bounds.width),
    y: edge(origin.y, handle.includes("n"), delta.y, bounds.height),
  };
  const corner2 = {
    x: edge(origin.x + origin.width, handle.includes("e"), delta.x, bounds.width),
    y: edge(origin.y + origin.height, handle.includes("s"), delta.y, bounds.height),
  };
  return spanRect(corner1, corner2);
}

export const HANDLE_CURSORS: Record<Handle, string> = {
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
};

/** CSS cursor for the current state; `hover` is what the pointer is over when not dragging. */
export function cursorFor(state: SelectionState, hover: Hit): string {
  switch (state.phase) {
    case "moving":
      return "move";
    case "resizing":
      return HANDLE_CURSORS[state.handle];
    case "selected":
      return hover === "outside"
        ? "crosshair"
        : hover === "inside"
          ? "move"
          : HANDLE_CURSORS[hover];
    default:
      return "crosshair";
  }
}

function clampPoint(point: Point, space: Space): Point {
  return { x: clamp(point.x, 0, space.width), y: clamp(point.y, 0, space.height) };
}

function press(state: SelectionState, point: Point, space: Space): SelectionState {
  if (state.phase !== "idle" && state.phase !== "selected") return state;
  const current = selectionRect(state);
  const hit = current ? hitTest(current, point, space.grab) : "outside";
  if (!current || hit === "outside") {
    // A drag outside the current selection starts a new one; a mere click keeps the old one.
    const anchor = clampPoint(point, space);
    return {
      phase: "creating",
      anchor,
      rect: spanRect(anchor, anchor),
      previous: current,
      dragged: false,
    };
  }
  if (hit === "inside") return { phase: "moving", rect: current, origin: current, start: point };
  return { phase: "resizing", rect: current, origin: current, start: point, handle: hit };
}

const sameRect = (a: Rect, b: Rect) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The state with `rect`, or the same state object if nothing changed: pointer moves that do not
 * change the selection must not re-render, nor re-report an unchanged region to Rust.
 */
function withRect<S extends SelectionState & { rect: Rect }>(state: S, rect: Rect): S {
  return sameRect(state.rect, rect) ? state : { ...state, rect };
}

function drag(state: SelectionState, point: Point, space: Space): SelectionState {
  switch (state.phase) {
    case "creating": {
      const end = clampPoint(point, space);
      const dragged =
        state.dragged ||
        Math.max(Math.abs(end.x - state.anchor.x), Math.abs(end.y - state.anchor.y)) > space.slop;
      const next = withRect(state, spanRect(state.anchor, end));
      return dragged === next.dragged ? next : { ...next, dragged };
    }
    case "moving": {
      const { origin, start } = state;
      // Shift, never shrink: the whole selection stays on this display.
      const x = clamp(origin.x + point.x - start.x, 0, space.width - origin.width);
      const y = clamp(origin.y + point.y - start.y, 0, space.height - origin.height);
      return withRect(state, { ...origin, x, y });
    }
    case "resizing": {
      const { origin, start, handle } = state;
      const delta = { x: point.x - start.x, y: point.y - start.y };
      return withRect(state, resizeRect(origin, handle, delta, space));
    }
    default:
      return state;
  }
}

const isEmpty = (rect: Rect) => rect.width <= 0 || rect.height <= 0;

function release(state: SelectionState): SelectionState {
  switch (state.phase) {
    case "creating":
      if (state.dragged && !isEmpty(state.rect)) return { phase: "selected", rect: state.rect };
      return state.previous ? { phase: "selected", rect: state.previous } : IDLE;
    // Unchanged edits keep the original rect object, so the region is not reported again.
    case "moving":
      return {
        phase: "selected",
        rect: sameRect(state.rect, state.origin) ? state.origin : state.rect,
      };
    case "resizing":
      // Squeezed to zero width or height: keep the selection as it was before this drag.
      return {
        phase: "selected",
        rect: isEmpty(state.rect) || sameRect(state.rect, state.origin) ? state.origin : state.rect,
      };
    default:
      return state;
  }
}

export function reduceSelection(
  state: SelectionState,
  action: SelectionAction,
  space: Space,
): SelectionState {
  if (state.phase === "cancelled") return state;
  switch (action.type) {
    case "press":
      return press(state, action.point, space);
    case "drag":
      return drag(state, action.point, space);
    case "release":
      return release(state);
    case "clear":
      return IDLE;
    case "cancel":
      return { phase: "cancelled" };
  }
}
