import { describe, expect, it } from "vitest";
import type { MeasureLine, Tool } from "./annotations";
import { clientToPixel, pixelToClient, type Point } from "./coords";
import {
  INITIAL_EDITOR,
  editorCursor,
  editorEnv,
  exportableRegion,
  reduceEditor,
  type EditorAction,
  type EditorEnv,
  type EditorState,
} from "./editor";
import { selectedRegion } from "./selection";

const measure: MeasureLine = (line, size) => line.length * size * 0.5;
const ENV = editorEnv({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, measure);

const press = (x: number, y: number): EditorAction => ({ type: "press", point: { x, y } });
const drag = (x: number, y: number): EditorAction => ({ type: "drag", point: { x, y } });
const release: EditorAction = { type: "release" };
const tool = (t: Tool): EditorAction => ({ type: "setTool", tool: t });

function run(state: EditorState, env: EditorEnv, ...actions: EditorAction[]): EditorState {
  return actions.reduce((s, a) => reduceEditor(s, a, env), state);
}
const gesture = (state: EditorState, from: Point, to: Point, env = ENV) =>
  run(state, env, press(from.x, from.y), drag(to.x, to.y), release);

/** Annotation positions on the frozen frame, independent of the region. */
const onScreen = (s: EditorState) =>
  s.annotate.history.present.map((a) =>
    a.kind === "arrow"
      ? { x: s.origin.x + a.from.x, y: s.origin.y + a.from.y }
      : a.kind === "rect"
        ? { x: s.origin.x + a.rect.x, y: s.origin.y + a.rect.y }
        : { x: s.origin.x + a.at.x, y: s.origin.y + a.at.y },
  );

// Region (100, 100) 400×300 with one arrow from (150, 150) to (250, 200) on screen.
const selected = gesture(INITIAL_EDITOR, { x: 100, y: 100 }, { x: 500, y: 400 });
const annotated = gesture(
  run(selected, ENV, tool("arrow")),
  { x: 150, y: 150 },
  { x: 250, y: 200 },
);

describe("annotation coordinates", () => {
  it("are relative to the selected region", () => {
    expect(annotated.origin).toEqual({ x: 100, y: 100 });
    expect(annotated.annotate.history.present[0]).toMatchObject({
      from: { x: 50, y: 50 },
      to: { x: 150, y: 100 },
    });
  });

  it("stay pinned to the screenshot when the region moves", () => {
    const s = gesture(run(annotated, ENV, tool("select")), { x: 400, y: 350 }, { x: 450, y: 370 });
    expect(selectedRegion(s.selection)).toEqual({ x: 150, y: 120, width: 400, height: 300 });
    expect(s.origin).toEqual({ x: 150, y: 120 });
    expect(s.annotate.history.present[0]).toMatchObject({ from: { x: 0, y: 30 } });
    expect(onScreen(s)).toEqual(onScreen(annotated));
  });

  it("stay pinned when the region is resized from its top-left corner", () => {
    const s = gesture(annotated, { x: 100, y: 100 }, { x: 160, y: 40 });
    expect(selectedRegion(s.selection)).toEqual({ x: 160, y: 40, width: 340, height: 360 });
    // The arrow's tail is now outside the region: kept and clipped, not deleted.
    expect(s.annotate.history.present[0]).toMatchObject({ from: { x: -10, y: 110 } });
    expect(onScreen(s)).toEqual(onScreen(annotated));
  });

  it("are kept for a new selection made outside, and undo still works", () => {
    const s = gesture(annotated, { x: 1000, y: 600 }, { x: 1200, y: 800 });
    expect(selectedRegion(s.selection)).toEqual({ x: 1000, y: 600, width: 200, height: 200 });
    expect(onScreen(s)).toEqual(onScreen(annotated));
    expect(run(s, ENV, { type: "undo" }).annotate.history.present).toEqual([]);
  });

  it("are not rebased for a click outside, which keeps the region", () => {
    const s = run(annotated, ENV, press(1000, 600), release);
    expect(s.annotate.history).toBe(annotated.annotate.history);
    expect(s.origin).toBe(annotated.origin);
    expect(s.annotate.selected).toBeNull(); // the press outside deselects
  });
});

describe("press routing", () => {
  it("resizes the region from its handles even with a drawing tool", () => {
    const s = gesture(
      run(annotated, ENV, { type: "deselect" }),
      { x: 500, y: 250 },
      { x: 600, y: 250 },
    );
    expect(selectedRegion(s.selection)?.width).toBe(500);
    expect(s.annotate.history.present).toHaveLength(1);
  });

  it("draws inside with a drawing tool instead of moving the region", () => {
    const s = gesture(annotated, { x: 300, y: 300 }, { x: 400, y: 380 });
    expect(selectedRegion(s.selection)).toEqual(selectedRegion(annotated.selection));
    expect(s.annotate.history.present).toHaveLength(2);
  });

  it("moves the region with the select tool on empty space, and deselects", () => {
    const s = run(annotated, ENV, tool("select"), press(400, 350));
    expect(s.selection.phase).toBe("moving");
    expect(s.annotate.selected).toBeNull();
  });

  it("moves an annotation, not the region, with the select tool", () => {
    const idle = run(annotated, ENV, tool("select"), { type: "deselect" });
    const s = gesture(idle, { x: 200, y: 175 }, { x: 220, y: 175 });
    expect(selectedRegion(s.selection)).toEqual(selectedRegion(annotated.selection));
    expect(s.annotate.history.present[0]).toMatchObject({ from: { x: 70, y: 50 } });
  });

  it("gives the selected annotation priority over the region's handles", () => {
    // A rectangle 10 px inside the region's left edge: their grab zones overlap at x = 105.
    const boxed = gesture(run(selected, ENV, tool("rect")), { x: 110, y: 150 }, { x: 200, y: 250 });
    const s = gesture(boxed, { x: 105, y: 200 }, { x: 130, y: 200 });
    expect(selectedRegion(s.selection)).toEqual(selectedRegion(boxed.selection));
    expect(s.annotate.history.present[0]).toMatchObject({ rect: { x: 35, width: 65 } });
  });

  it("only ends text editing on a press while editing", () => {
    const editing = run(selected, ENV, tool("text"), press(200, 200), release, {
      type: "type",
      text: "Not",
    });
    const s = gesture(editing, { x: 300, y: 300 }, { x: 400, y: 380 });
    expect(s.annotate.history.present).toMatchObject([{ kind: "text", text: "Not" }]);
    expect(s.annotate.gesture).toBeNull();
    expect(selectedRegion(s.selection)).toEqual(selectedRegion(selected.selection));
  });

  it("ignores toolbar actions before a region exists", () => {
    expect(run(INITIAL_EDITOR, ENV, tool("arrow"), { type: "undo" })).toBe(INITIAL_EDITOR);
  });
});

describe("clear and cancel", () => {
  it("drops the annotations when another display takes the selection", () => {
    const s = run(annotated, ENV, { type: "clear" });
    expect(s.selection.phase).toBe("idle");
    expect(s.annotate.history.present).toEqual([]);
    expect(s.annotate.tool).toBe("arrow");
  });

  it("ignores everything after Escape, from any annotation state", () => {
    const states = [
      annotated,
      run(annotated, ENV, press(300, 300), drag(350, 350)),
      run(selected, ENV, tool("text"), press(200, 200), release),
    ];
    for (const state of states) {
      const cancelled = run(state, ENV, { type: "cancel" });
      expect(cancelled.selection.phase).toBe("cancelled");
      expect(run(cancelled, ENV, press(10, 10), drag(50, 50), release, { type: "undo" })).toBe(
        cancelled,
      );
    }
  });
});

describe("exportableRegion", () => {
  it("is the selected region when nothing is being dragged", () => {
    expect(exportableRegion(annotated)).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(exportableRegion(INITIAL_EDITOR)).toBeNull();
  });

  it("is null while an annotation is drawn or moved", () => {
    // Regression: Enter or Cmd+C mid-drag exported the committed history, so the shape
    // being drawn on screen was missing from the image.
    const drawing = run(annotated, ENV, press(300, 300), drag(350, 350));
    expect(drawing.annotate.gesture?.type).toBe("drawing");
    expect(exportableRegion(drawing)).toBeNull();
    expect(exportableRegion(run(drawing, ENV, release))).not.toBeNull();
    const moving = run(annotated, ENV, tool("select"), press(200, 175), drag(210, 180));
    expect(moving.annotate.gesture?.type).toBe("moving");
    expect(exportableRegion(moving)).toBeNull();
  });

  it("is null while the region itself is dragged", () => {
    expect(exportableRegion(run(selected, ENV, press(300, 250), drag(320, 260)))).toBeNull();
  });

  it("allows a text being edited, which the overlay commits first", () => {
    const editing = run(selected, ENV, tool("text"), press(200, 200), release);
    expect(editing.annotate.gesture?.type).toBe("editing");
    expect(exportableRegion(editing)).not.toBeNull();
  });
});

describe("cursor", () => {
  it("follows the same priorities as presses", () => {
    expect(editorCursor(annotated, { x: 200, y: 175 }, ENV)).toBe("move"); // selected arrow
    expect(editorCursor(annotated, { x: 300, y: 300 }, ENV)).toBe("crosshair"); // arrow tool
    expect(editorCursor(annotated, { x: 500, y: 250 }, ENV)).toBe("ew-resize"); // region edge
    expect(editorCursor(annotated, { x: 900, y: 900 }, ENV)).toBe("crosshair"); // outside
    const text = run(annotated, ENV, tool("text"));
    expect(editorCursor(text, { x: 300, y: 300 }, ENV)).toBe("text");
    const select = run(annotated, ENV, tool("select"), { type: "deselect" });
    expect(editorCursor(select, { x: 300, y: 300 }, ENV)).toBe("move");
  });
});

describe("Retina alignment", () => {
  // Built-in display: 1512×982 pt window, 3024×1964 px frame.
  const view = { width: 1512, height: 982 };
  const frame = { width: 3024, height: 1964 };
  const retina = editorEnv(view, frame, measure);
  const px = (x: number, y: number) => clientToPixel({ x, y }, view, frame);

  it("draws in physical pixels with strokes scaled to look the same", () => {
    const region = gesture(INITIAL_EDITOR, px(100, 100), px(500, 400), retina);
    const s = gesture(run(region, retina, tool("arrow")), px(150.5, 150), px(250, 200), retina);
    expect(s.annotate.history.present[0]).toMatchObject({
      from: { x: 101, y: 100 },
      to: { x: 300, y: 200 },
      width: 8, // 4 CSS px
    });
    // Mapping the on-screen position back gives the pointer position: no drift on 2× displays.
    const [start = { x: NaN, y: NaN }] = onScreen(s);
    expect(pixelToClient({ ...start, width: 0, height: 0 }, view, frame)).toMatchObject({
      x: 150.5,
      y: 150,
    });
  });

  it("uses CSS-sized tolerances, so a 2× display grabs from as far away", () => {
    const region = gesture(INITIAL_EDITOR, px(100, 100), px(500, 400), retina);
    const s = gesture(run(region, retina, tool("arrow")), px(150, 150), px(250, 150), retina);
    // 7 CSS px above the shaft: within the 8 CSS px grab plus half the stroke.
    expect(editorCursor(s, px(200, 143), retina)).toBe("move");
    expect(editorCursor(s, px(200, 135), retina)).not.toBe("move");
  });
});
