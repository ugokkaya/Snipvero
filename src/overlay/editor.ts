// One overlay's editor: the region selection (selection.ts) plus the annotations on it (annotate.ts).
// Pure. It decides which model a press belongs to and keeps the annotations pinned to the frozen
// screenshot when the region moves or is resized.
//
// Annotations are stored relative to `origin`, the region's top-left corner in frame pixels. When a
// region change is finalized with a new top-left corner, they are rebased by the difference, so they
// stay on the same screenshot pixels and remain region-relative. Parts outside the region are hidden
// (clipped), not deleted, and come back if the region grows over them again.

import { pixelRatio, type Point, type Rect, type Size } from "./coords";
import {
  INITIAL_ANNOTATE,
  grabsSelected,
  reduceAnnotate,
  selectedHandle,
  wantsInside,
  type AnnotateAction,
  type AnnotateEnv,
  type AnnotateState,
} from "./annotate";
import type { MeasureLine } from "./annotations";
import {
  HANDLE_CURSORS,
  IDLE,
  cursorFor,
  hitTest,
  isDragging,
  reduceSelection,
  selectedRegion,
  spaceFor,
  type SelectionAction,
  type SelectionState,
  type Space,
} from "./selection";

export interface EditorState {
  selection: SelectionState;
  annotate: AnnotateState;
  /** Frame pixel position the annotation coordinates are relative to. */
  origin: Point;
}

export interface EditorEnv {
  space: Space;
  /** Frame pixels per CSS pixel. */
  scale: number;
  measure: MeasureLine;
}

/** Toolbar and keyboard actions; pointer actions and clear/cancel come from `SelectionAction`. */
export type EditorAction =
  SelectionAction | Exclude<AnnotateAction, { type: "press" | "drag" | "release" | "rebase" }>;

export const INITIAL_EDITOR: EditorState = {
  selection: IDLE,
  annotate: INITIAL_ANNOTATE,
  origin: { x: 0, y: 0 },
};

export function editorEnv(view: Size, frame: Size, measure: MeasureLine): EditorEnv {
  const ratio = pixelRatio(view, frame);
  return { space: spaceFor(view, frame), scale: Math.max(ratio.x, ratio.y), measure };
}

function annotateEnv(env: EditorEnv, bounds: Size): AnnotateEnv {
  const { grab, slop } = env.space;
  return { bounds, grab, slop, scale: env.scale, measure: env.measure };
}

const relative = (p: Point, origin: Point): Point => ({ x: p.x - origin.x, y: p.y - origin.y });

/** Whether an annotation gesture (other than text editing, which ignores the pointer) is active. */
const annotating = (s: EditorState) =>
  s.annotate.gesture !== null && s.annotate.gesture.type !== "editing";

/** After a region change: rebase the annotations onto the region's new top-left corner. */
function settle(s: EditorState): EditorState {
  const region = selectedRegion(s.selection);
  if (!region || (region.x === s.origin.x && region.y === s.origin.y)) return s;
  const rebase = { type: "rebase", dx: s.origin.x - region.x, dy: s.origin.y - region.y } as const;
  return {
    ...s,
    annotate: reduceAnnotate(s.annotate, rebase, annotateEnv(NO_BOUNDS_ENV, region)),
    origin: { x: region.x, y: region.y },
  };
}

// Rebasing needs no tolerances or measurement.
const NO_BOUNDS_ENV: EditorEnv = {
  space: { width: 0, height: 0, grab: 0, slop: 0 },
  scale: 1,
  measure: () => 0,
};

/**
 * Press priority, so annotating never happens by accident while editing the region:
 * 1. while a text is being edited, a press anywhere only ends the edit;
 * 2. the selected annotation's own handles and body;
 * 3. the region's handles, and everything outside it (a new selection, as without annotations);
 * 4. inside: a drawing tool annotates; the select tool picks an annotation, else moves the region.
 */
function press(s: EditorState, point: Point, env: EditorEnv): EditorState {
  const region = selectedRegion(s.selection);
  const toSelection = (state: EditorState): EditorState => ({
    ...state,
    selection: reduceSelection(state.selection, { type: "press", point }, env.space),
  });
  if (!region) return toSelection(s);
  const aenv = annotateEnv(env, region);
  const local = relative(point, s.origin);
  const toAnnotate = (action: AnnotateAction) => ({
    ...s,
    annotate: reduceAnnotate(s.annotate, action, aenv),
  });
  if (s.annotate.gesture?.type === "editing") return toAnnotate({ type: "commitText" });
  if (s.annotate.gesture) return s;
  if (grabsSelected(s.annotate, local, aenv)) return toAnnotate({ type: "press", point: local });
  const hit = hitTest(region, point, env.space.grab);
  if (hit === "inside" && wantsInside(s.annotate, local, aenv)) {
    return toAnnotate({ type: "press", point: local });
  }
  return toSelection(toAnnotate({ type: "deselect" }));
}

export function reduceEditor(
  state: EditorState,
  action: EditorAction,
  env: EditorEnv,
): EditorState {
  if (state.selection.phase === "cancelled") return state;
  const region = selectedRegion(state.selection);
  switch (action.type) {
    case "press":
      return press(state, action.point, env);
    case "drag":
      if (annotating(state) && region) {
        const point = relative(action.point, state.origin);
        const annotate = reduceAnnotate(
          state.annotate,
          { type: "drag", point },
          annotateEnv(env, region),
        );
        return annotate === state.annotate ? state : { ...state, annotate };
      }
      return withSelection(state, action, env);
    case "release":
      if (annotating(state) && region) {
        return {
          ...state,
          annotate: reduceAnnotate(state.annotate, action, annotateEnv(env, region)),
        };
      }
      return settle(withSelection(state, action, env));
    case "clear":
      // Another display took the selection; these annotations belonged to this display's region.
      return {
        ...INITIAL_EDITOR,
        annotate: { ...INITIAL_ANNOTATE, tool: state.annotate.tool, style: state.annotate.style },
      };
    case "cancel":
      return withSelection(state, action, env);
    default: {
      // Toolbar and keyboard actions only apply once a region is selected.
      if (!region) return state;
      const annotate = reduceAnnotate(state.annotate, action, annotateEnv(env, region));
      return annotate === state.annotate ? state : { ...state, annotate };
    }
  }
}

function withSelection(state: EditorState, action: SelectionAction, env: EditorEnv): EditorState {
  const selection = reduceSelection(state.selection, action, env.space);
  return selection === state.selection ? state : { ...state, selection };
}

/** CSS cursor for a pointer at `point` (frame pixels), from the same rules as `press`. */
/**
 * The region an export may take now, or null. Not while the region or an annotation is being
 * dragged: the export would take the committed history, not the shape on screen. A text being
 * edited is fine; the overlay commits it first.
 */
export function exportableRegion(s: EditorState): Rect | null {
  const gesture = s.annotate.gesture;
  return gesture === null || gesture.type === "editing" ? selectedRegion(s.selection) : null;
}

export function editorCursor(s: EditorState, point: Point, env: EditorEnv): string {
  const region = selectedRegion(s.selection);
  if (!region || isDragging(s.selection)) return cursorFor(s.selection, "outside");
  const g = s.annotate.gesture;
  if (g) {
    switch (g.type) {
      case "moving":
        return "move";
      case "resizing":
        return HANDLE_CURSORS[g.handle];
      case "drawing":
        return "crosshair";
      default:
        return "text";
    }
  }
  const aenv = annotateEnv(env, region);
  const local = relative(point, s.origin);
  const handle = selectedHandle(s.annotate, local, aenv);
  if (handle) return handle === "body" ? "move" : HANDLE_CURSORS[handle];
  const hit = hitTest(region, point, env.space.grab);
  if (hit !== "inside") return cursorFor(s.selection, hit);
  switch (s.annotate.tool) {
    case "text":
      return "text";
    case "select":
      return "move";
    default:
      return "crosshair";
  }
}
