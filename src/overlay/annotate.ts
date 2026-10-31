// Annotation editing for one selected region: tools, style, the selected annotation, the gesture in
// progress and undo/redo history. Pure, like selection.ts: no React, DOM or IPC.
//
// Points are in frame pixels relative to the region's top-left corner (annotations.ts); editor.ts
// converts them and decides which presses reach this reducer.

import { clamp, spanRect, type Point, type Size } from "./coords";
import {
  DEFAULT_STYLE,
  annotationAt,
  fontSize,
  hitsAnnotation,
  strokeWidth,
  styleOf,
  translate,
  withStyle,
  type Annotation,
  type ArrowAnnotation,
  type MeasureLine,
  type RectAnnotation,
  type SizeLevel,
  type Style,
  type TextAnnotation,
  type Tool,
} from "./annotations";
import { hitTest, resizeRect, type Handle } from "./selection";

/** Snapshots are cheap: annotations are small immutable objects shared between entries. */
export interface History {
  past: readonly (readonly Annotation[])[];
  present: readonly Annotation[];
  future: readonly (readonly Annotation[])[];
}

const HISTORY_LIMIT = 100;

export type Gesture =
  | { type: "drawing"; draft: ArrowAnnotation | RectAnnotation; anchor: Point; dragged: boolean }
  /** Text tool pressed on empty space: the editor opens on release, after focus has settled. */
  | { type: "placing"; at: Point }
  | {
      type: "moving";
      origin: Annotation;
      current: Annotation;
      start: Point;
      /** Already selected before this press: a click on a selected text edits it. */
      wasSelected: boolean;
      /** Travelled beyond the click slop; a click never nudges an annotation. */
      moved: boolean;
    }
  | {
      type: "resizing";
      origin: RectAnnotation;
      current: RectAnnotation;
      start: Point;
      handle: Handle;
    }
  | { type: "editing"; draft: TextAnnotation; isNew: boolean };

export interface AnnotateState {
  history: History;
  tool: Tool;
  style: Style;
  selected: number | null;
  gesture: Gesture | null;
  nextId: number;
}

export interface AnnotateEnv {
  /** Size of the selected region; annotation input is clamped to it. */
  bounds: Size;
  /** Pointer tolerances in frame pixels (see selection.ts `Space`). */
  grab: number;
  slop: number;
  /** Frame pixels per CSS pixel, for style presets. */
  scale: number;
  measure: MeasureLine;
}

export type AnnotateAction =
  | { type: "press"; point: Point }
  | { type: "drag"; point: Point }
  | { type: "release" }
  | { type: "type"; text: string }
  | { type: "commitText" }
  | { type: "setTool"; tool: Tool }
  | { type: "setColor"; color: string }
  | { type: "setSize"; size: SizeLevel }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "delete" }
  | { type: "deselect" }
  /** The region's origin moved by (-dx, -dy): shift everything so it stays on the same pixels. */
  | { type: "rebase"; dx: number; dy: number };

export const INITIAL_ANNOTATE: AnnotateState = {
  history: { past: [], present: [], future: [] },
  tool: "select",
  style: DEFAULT_STYLE,
  selected: null,
  gesture: null,
  nextId: 1,
};

export const canUndo = (s: AnnotateState) => s.history.past.length > 0;
export const canRedo = (s: AnnotateState) => s.history.future.length > 0;

/** The selected annotation as currently shown, including an edit in progress. */
export function selectedAnnotation(s: AnnotateState): Annotation | null {
  const g = s.gesture;
  if (g && (g.type === "moving" || g.type === "resizing") && g.current.id === s.selected) {
    return g.current;
  }
  return s.history.present.find((a) => a.id === s.selected) ?? null;
}

/**
 * What to draw: the history's present with the gesture in progress applied. A text being edited
 * is left out, because the textarea shows it.
 */
export function displayedAnnotations(s: AnnotateState): readonly Annotation[] {
  const g = s.gesture;
  const list = s.history.present;
  if (!g) return list;
  switch (g.type) {
    case "drawing":
      return g.dragged ? [...list, g.draft] : list;
    case "moving":
    case "resizing":
      return list.map((a) => (a.id === g.current.id ? g.current : a));
    case "editing":
      return list.filter((a) => a.id !== g.draft.id);
    case "placing":
      return list;
  }
}

function commit(state: AnnotateState, present: readonly Annotation[]): AnnotateState {
  const { history } = state;
  if (present === history.present) return state;
  return {
    ...state,
    history: {
      past: [...history.past, history.present].slice(-HISTORY_LIMIT),
      present,
      future: [],
    },
  };
}

const replace = (list: readonly Annotation[], next: Annotation) =>
  list.map((a) => (a.id === next.id ? next : a));

function clampPoint(p: Point, bounds: Size): Point {
  return { x: clamp(p.x, 0, bounds.width), y: clamp(p.y, 0, bounds.height) };
}

type Target = { type: "body" } | { type: "handle"; handle: Handle };

/** What a press at `p` grabs of the selected annotation, if anything. Only rectangles resize. */
function selectedTarget(s: AnnotateState, p: Point, env: AnnotateEnv): Target | null {
  const a = selectedAnnotation(s);
  if (!a) return null;
  if (a.kind === "rect") {
    const hit = hitTest(a.rect, p, env.grab + a.width / 2);
    if (hit === "outside") return null;
    // A selected rectangle can be dragged from inside too, which is easier than its thin border.
    return hit === "inside" ? { type: "body" } : { type: "handle", handle: hit };
  }
  return hitsAnnotation(a, p, env.grab, env.measure) ? { type: "body" } : null;
}

/** The handle under `p` on the selected rectangle, for the cursor; null elsewhere. */
export function selectedHandle(
  s: AnnotateState,
  p: Point,
  env: AnnotateEnv,
): Handle | "body" | null {
  const target = selectedTarget(s, p, env);
  return target === null ? null : target.type === "body" ? "body" : target.handle;
}

/** Whether a press grabs the selected annotation; it then wins over the region's handles. */
export const grabsSelected = (s: AnnotateState, p: Point, env: AnnotateEnv) =>
  s.gesture === null && selectedTarget(s, p, env) !== null;

/**
 * Whether a press inside the region (away from its handles) is for annotating: always with a
 * drawing tool, and over an annotation with the select tool. Otherwise it moves the region.
 */
export const wantsInside = (s: AnnotateState, p: Point, env: AnnotateEnv) =>
  s.gesture === null &&
  (s.tool !== "select" || annotationAt(s.history.present, p, env.grab, env.measure) !== null);

function startMoving(
  s: AnnotateState,
  a: Annotation,
  start: Point,
  wasSelected: boolean,
): AnnotateState {
  return {
    ...s,
    selected: a.id,
    gesture: { type: "moving", origin: a, current: a, start, wasSelected, moved: false },
  };
}

function press(s: AnnotateState, raw: Point, env: AnnotateEnv): AnnotateState {
  if (s.gesture) return s;
  const point = clampPoint(raw, env.bounds);
  const target = selectedTarget(s, raw, env);
  const selected = selectedAnnotation(s);
  if (target && selected) {
    if (target.type === "handle" && selected.kind === "rect") {
      return {
        ...s,
        gesture: {
          type: "resizing",
          origin: selected,
          current: selected,
          start: point,
          handle: target.handle,
        },
      };
    }
    return startMoving(s, selected, point, true);
  }
  const hit = annotationAt(s.history.present, raw, env.grab, env.measure);
  switch (s.tool) {
    case "select":
      return hit ? select(startMoving(s, hit, point, false), hit, env) : { ...s, selected: null };
    case "text":
      // A click on a text edits it (on release); a drag moves it.
      if (hit?.kind === "text") return select(startMoving(s, hit, point, false), hit, env);
      return { ...s, selected: null, gesture: { type: "placing", at: point } };
    case "arrow":
    case "rect": {
      const base = {
        id: s.nextId,
        color: s.style.color,
        width: strokeWidth(s.style.size, env.scale),
      };
      const draft: ArrowAnnotation | RectAnnotation =
        s.tool === "arrow"
          ? { kind: "arrow", ...base, from: point, to: point }
          : { kind: "rect", ...base, rect: spanRect(point, point) };
      return {
        ...s,
        selected: null,
        gesture: { type: "drawing", draft, anchor: point, dragged: false },
      };
    }
  }
}

/** Selecting an annotation shows its colour and size, which then also apply to new ones. */
const select = (s: AnnotateState, a: Annotation, env: AnnotateEnv): AnnotateState => ({
  ...s,
  selected: a.id,
  style: styleOf(a, env.scale),
});

function drag(s: AnnotateState, raw: Point, env: AnnotateEnv): AnnotateState {
  const g = s.gesture;
  if (!g) return s;
  const point = clampPoint(raw, env.bounds);
  switch (g.type) {
    case "drawing": {
      const dragged =
        g.dragged ||
        Math.max(Math.abs(point.x - g.anchor.x), Math.abs(point.y - g.anchor.y)) > env.slop;
      const draft: ArrowAnnotation | RectAnnotation =
        g.draft.kind === "arrow"
          ? { ...g.draft, to: point }
          : { ...g.draft, rect: spanRect(g.anchor, point) };
      return { ...s, gesture: { ...g, draft, dragged } };
    }
    case "moving": {
      const dx = point.x - g.start.x;
      const dy = point.y - g.start.y;
      const moved = g.moved || Math.max(Math.abs(dx), Math.abs(dy)) > env.slop;
      return { ...s, gesture: { ...g, moved, current: translate(g.origin, dx, dy) } };
    }
    case "resizing": {
      const delta = { x: point.x - g.start.x, y: point.y - g.start.y };
      const rect = resizeRect(g.origin.rect, g.handle, delta, env.bounds);
      return { ...s, gesture: { ...g, current: { ...g.origin, rect } } };
    }
    default:
      return s;
  }
}

function newText(s: AnnotateState, at: Point, env: AnnotateEnv): TextAnnotation {
  return {
    kind: "text",
    id: s.nextId,
    color: s.style.color,
    fontSize: fontSize(s.style.size, env.scale),
    at,
    text: "",
  };
}

function release(s: AnnotateState, env: AnnotateEnv): AnnotateState {
  const g = s.gesture;
  if (!g) return s;
  const done = { ...s, gesture: null };
  switch (g.type) {
    case "drawing": {
      const d = g.draft;
      const empty =
        d.kind === "arrow"
          ? d.from.x === d.to.x && d.from.y === d.to.y
          : d.rect.width <= 0 || d.rect.height <= 0;
      if (!g.dragged || empty) return done;
      return { ...commit(done, [...s.history.present, d]), selected: d.id, nextId: s.nextId + 1 };
    }
    case "placing":
      return { ...s, gesture: { type: "editing", draft: newText(s, g.at, env), isNew: true } };
    case "moving":
      if (g.moved) {
        // Dragged away and back: translate() returned the original, so nothing to record.
        return g.current === g.origin ? done : commit(done, replace(s.history.present, g.current));
      }
      if (g.origin.kind === "text" && (s.tool === "text" || g.wasSelected)) {
        return { ...s, gesture: { type: "editing", draft: g.origin, isNew: false } };
      }
      return done;
    case "resizing": {
      const { rect } = g.current;
      const o = g.origin.rect;
      const unchanged =
        rect.x === o.x && rect.y === o.y && rect.width === o.width && rect.height === o.height;
      // Squeezed to zero width or height: keep the rectangle as it was, like the selection.
      if (rect.width <= 0 || rect.height <= 0 || unchanged) return done;
      return commit(done, replace(s.history.present, g.current));
    }
    case "editing":
      return s;
  }
}

/** Ends text editing: a blank new text is dropped, a blanked existing one is deleted. */
function commitText(s: AnnotateState): AnnotateState {
  const g = s.gesture;
  if (g?.type !== "editing") return s;
  const done = { ...s, gesture: null };
  const blank = g.draft.text.trim() === "";
  const list = s.history.present;
  if (g.isNew) {
    if (blank) return done;
    return { ...commit(done, [...list, g.draft]), selected: g.draft.id, nextId: s.nextId + 1 };
  }
  if (blank) {
    return {
      ...commit(
        done,
        list.filter((a) => a.id !== g.draft.id),
      ),
      selected: null,
    };
  }
  const original = list.find((a) => a.id === g.draft.id);
  if (!original || original === g.draft) return { ...done, selected: g.draft.id };
  return { ...commit(done, replace(list, g.draft)), selected: g.draft.id };
}

function restyle(s: AnnotateState, style: Style, env: AnnotateEnv): AnnotateState {
  const next = { ...s, style };
  const g = s.gesture;
  if (g?.type === "editing") {
    const draft = withStyle(g.draft, style, env.scale) as TextAnnotation;
    return { ...next, gesture: { ...g, draft } };
  }
  if (g) return next;
  const selected = selectedAnnotation(s);
  if (!selected) return next;
  const restyled = withStyle(selected, style, env.scale);
  return restyled === selected ? next : commit(next, replace(s.history.present, restyled));
}

/** Drops the selection if the annotation no longer exists (after undo, redo or delete). */
function keepSelection(s: AnnotateState): AnnotateState {
  return s.selected !== null && !s.history.present.some((a) => a.id === s.selected)
    ? { ...s, selected: null }
    : s;
}

function undo(s: AnnotateState): AnnotateState {
  if (s.gesture) return s;
  const { past, present, future } = s.history;
  const previous = past[past.length - 1];
  if (!previous) return s;
  return keepSelection({
    ...s,
    history: { past: past.slice(0, -1), present: previous, future: [present, ...future] },
  });
}

function redo(s: AnnotateState): AnnotateState {
  if (s.gesture) return s;
  const { past, present, future } = s.history;
  const next = future[0];
  if (!next) return s;
  return keepSelection({
    ...s,
    history: { past: [...past, present], present: next, future: future.slice(1) },
  });
}

function rebase(s: AnnotateState, dx: number, dy: number): AnnotateState {
  if (dx === 0 && dy === 0) return s;
  const shift = (list: readonly Annotation[]) => list.map((a) => translate(a, dx, dy));
  const { past, present, future } = s.history;
  return {
    ...s,
    history: { past: past.map(shift), present: shift(present), future: future.map(shift) },
  };
}

export function reduceAnnotate(
  state: AnnotateState,
  action: AnnotateAction,
  env: AnnotateEnv,
): AnnotateState {
  switch (action.type) {
    case "press":
      return press(state, action.point, env);
    case "drag":
      return drag(state, action.point, env);
    case "release":
      return release(state, env);
    case "type": {
      const g = state.gesture;
      if (g?.type !== "editing" || g.draft.text === action.text) return state;
      return { ...state, gesture: { ...g, draft: { ...g.draft, text: action.text } } };
    }
    case "commitText":
      return commitText(state);
    case "setTool": {
      const s = commitText(state);
      return s.gesture || s.tool === action.tool ? s : { ...s, tool: action.tool };
    }
    case "setColor":
      return restyle(state, { ...state.style, color: action.color }, env);
    case "setSize":
      return restyle(state, { ...state.style, size: action.size }, env);
    case "undo":
      return undo(commitText(state));
    case "redo":
      return redo(commitText(state));
    case "delete": {
      if (state.gesture || state.selected === null) return state;
      const list = state.history.present.filter((a) => a.id !== state.selected);
      if (list.length === state.history.present.length) return state;
      return { ...commit(state, list), selected: null };
    }
    case "deselect":
      return state.gesture || state.selected === null ? state : { ...state, selected: null };
    case "rebase":
      return rebase(state, action.dx, action.dy);
  }
}
