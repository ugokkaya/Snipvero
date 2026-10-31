import { describe, expect, it } from "vitest";
import {
  INITIAL_ANNOTATE,
  canRedo,
  canUndo,
  displayedAnnotations,
  grabsSelected,
  reduceAnnotate,
  selectedAnnotation,
  wantsInside,
  type AnnotateAction,
  type AnnotateEnv,
  type AnnotateState,
} from "./annotate";
import type { MeasureLine, Tool } from "./annotations";

const measure: MeasureLine = (line, size) => line.length * size * 0.5;
/** A 400×300 region on a 1× display. */
const ENV: AnnotateEnv = {
  bounds: { width: 400, height: 300 },
  grab: 8,
  slop: 3,
  scale: 1,
  measure,
};

const press = (x: number, y: number): AnnotateAction => ({ type: "press", point: { x, y } });
const drag = (x: number, y: number): AnnotateAction => ({ type: "drag", point: { x, y } });
const release: AnnotateAction = { type: "release" };
const tool = (t: Tool): AnnotateAction => ({ type: "setTool", tool: t });
const type = (text: string): AnnotateAction => ({ type: "type", text });
const commitText: AnnotateAction = { type: "commitText" };

function run(state: AnnotateState, ...actions: AnnotateAction[]): AnnotateState {
  return actions.reduce((s, a) => reduceAnnotate(s, a, ENV), state);
}
const gesture = (state: AnnotateState, from: [number, number], to: [number, number]) =>
  run(state, press(...from), drag(...to), release);

const present = (s: AnnotateState) => s.history.present;
const withArrow = gesture(run(INITIAL_ANNOTATE, tool("arrow")), [10, 20], [110, 70]);
const withRect = gesture(run(INITIAL_ANNOTATE, tool("rect")), [150, 100], [50, 50]);

describe("arrow tool", () => {
  it("draws with a live preview and commits on release", () => {
    const drawing = run(INITIAL_ANNOTATE, tool("arrow"), press(10, 20), drag(60, 40));
    expect(present(drawing)).toEqual([]);
    expect(displayedAnnotations(drawing)).toMatchObject([
      { kind: "arrow", from: { x: 10, y: 20 }, to: { x: 60, y: 40 } },
    ]);
    expect(present(withArrow)).toEqual([
      {
        kind: "arrow",
        id: 1,
        color: "#ff3b30",
        width: 4,
        from: { x: 10, y: 20 },
        to: { x: 110, y: 70 },
      },
    ]);
    // The new arrow is selected, so it can be moved or deleted right away.
    expect(withArrow.selected).toBe(1);
  });

  it("creates nothing for a click", () => {
    const clicked = gesture(run(INITIAL_ANNOTATE, tool("arrow")), [10, 20], [12, 21]);
    expect(present(clicked)).toEqual([]);
    expect(canUndo(clicked)).toBe(false);
  });

  it("stays inside the region", () => {
    const s = gesture(run(INITIAL_ANNOTATE, tool("arrow")), [10, 20], [900, -50]);
    expect(present(s)[0]).toMatchObject({ to: { x: 400, y: 0 } });
  });

  it("uses the current colour and size", () => {
    const s = run(
      INITIAL_ANNOTATE,
      tool("arrow"),
      { type: "setColor", color: "#34c759" },
      { type: "setSize", size: 2 },
    );
    expect(present(gesture(s, [0, 0], [50, 50]))[0]).toMatchObject({ color: "#34c759", width: 8 });
  });

  it("moves an arrow by its shaft and deletes it", () => {
    const moved = run(withArrow, press(60, 45), drag(70, 55), release);
    expect(present(moved)[0]).toMatchObject({ from: { x: 20, y: 30 }, to: { x: 120, y: 80 } });
    const deleted = run(moved, { type: "delete" });
    expect(present(deleted)).toEqual([]);
    expect(deleted.selected).toBeNull();
  });
});

describe("rectangle tool", () => {
  it("draws in any direction and normalizes the rectangle", () => {
    expect(present(withRect)).toMatchObject([
      { kind: "rect", rect: { x: 50, y: 50, width: 100, height: 50 } },
    ]);
  });

  it("rejects a zero-height drag", () => {
    const s = gesture(run(INITIAL_ANNOTATE, tool("rect")), [10, 10], [100, 10]);
    expect(present(s)).toEqual([]);
  });

  it("moves when dragged inside once selected", () => {
    const s = run(withRect, press(100, 75), drag(90, 95), release);
    expect(present(s)[0]).toMatchObject({ rect: { x: 40, y: 70, width: 100, height: 50 } });
  });

  it("resizes from a corner handle and flips past the opposite edge", () => {
    const grown = run(withRect, press(150, 100), drag(200, 140), release);
    expect(present(grown)[0]).toMatchObject({ rect: { x: 50, y: 50, width: 150, height: 90 } });
    const flipped = run(withRect, press(50, 75), drag(200, 75), release); // west edge
    expect(present(flipped)[0]).toMatchObject({ rect: { x: 150, y: 50, width: 50, height: 50 } });
  });

  it("keeps the rectangle when resized to zero and clamps to the region", () => {
    const squeezed = run(withRect, press(150, 75), drag(50, 75), release);
    expect(present(squeezed)).toBe(present(withRect));
    const clamped = run(withRect, press(150, 100), drag(999, 999), release);
    expect(present(clamped)[0]).toMatchObject({ rect: { x: 50, y: 50, width: 350, height: 250 } });
  });

  it("does not record a click on the selected rectangle", () => {
    const s = run(withRect, press(100, 75), drag(101, 76), release);
    expect(s.history).toBe(withRect.history);
  });
});

describe("selection of annotations", () => {
  it("prefers the selected annotation, then annotations under the pointer", () => {
    expect(grabsSelected(withRect, { x: 100, y: 75 }, ENV)).toBe(true);
    expect(grabsSelected(withRect, { x: 300, y: 250 }, ENV)).toBe(false);
    const idle = run(withRect, tool("select"), { type: "deselect" });
    expect(wantsInside(idle, { x: 50, y: 75 }, ENV)).toBe(true);
    // Inside an unselected outline, the select tool leaves the press to the region.
    expect(wantsInside(idle, { x: 100, y: 75 }, ENV)).toBe(false);
    expect(wantsInside(run(idle, tool("arrow")), { x: 300, y: 250 }, ENV)).toBe(true);
  });

  it("selects with the select tool and shows the annotation's style", () => {
    const other = run(withRect, { type: "deselect" }, tool("select"), {
      type: "setColor",
      color: "#ffcc00",
    });
    const s = run(other, press(50, 75), release);
    expect(s.selected).toBe(1);
    expect(s.style).toEqual({ color: "#ff3b30", size: 1 });
    expect(selectedAnnotation(s)?.kind).toBe("rect");
  });

  it("restyles the selected annotation as one undo step", () => {
    const s = run(withRect, { type: "setColor", color: "#000000" });
    expect(present(s)[0]).toMatchObject({ color: "#000000" });
    expect(present(run(s, { type: "undo" }))[0]).toMatchObject({ color: "#ff3b30" });
  });
});

describe("text tool", () => {
  const placed = run(INITIAL_ANNOTATE, tool("text"), press(30, 40), release);

  it("opens an editor on click and commits Turkish text", () => {
    expect(placed.gesture).toMatchObject({
      type: "editing",
      isNew: true,
      draft: { at: { x: 30, y: 40 } },
    });
    const s = run(placed, type("Merhaba dünya: çğıöşü ÇĞİÖŞÜ"), commitText);
    expect(present(s)).toEqual([
      {
        kind: "text",
        id: 1,
        color: "#ff3b30",
        fontSize: 20,
        at: { x: 30, y: 40 },
        text: "Merhaba dünya: çğıöşü ÇĞİÖŞÜ",
      },
    ]);
    expect(s.selected).toBe(1);
    expect(s.gesture).toBeNull();
  });

  it("drops an empty new text", () => {
    const s = run(placed, type("  \n"), commitText);
    expect(present(s)).toEqual([]);
    expect(canUndo(s)).toBe(false);
  });

  it("edits an existing text on click, and deletes it when emptied", () => {
    const written = run(placed, type("İlk"), commitText);
    const editing = run(written, press(35, 45), release);
    expect(editing.gesture).toMatchObject({ type: "editing", isNew: false });
    expect(displayedAnnotations(editing)).toEqual([]); // the textarea shows it
    const edited = run(editing, type("İlk satır\nikinci"), commitText);
    expect(present(edited)[0]).toMatchObject({ text: "İlk satır\nikinci" });
    const emptied = run(edited, press(35, 45), release, type(""), commitText);
    expect(present(emptied)).toEqual([]);
    expect(present(run(emptied, { type: "undo" }))[0]).toMatchObject({ text: "İlk satır\nikinci" });
  });

  it("does not record an unchanged edit", () => {
    const written = run(placed, type("Aynı"), commitText);
    const s = run(written, press(35, 45), release, commitText);
    expect(s.history).toBe(written.history);
  });

  it("moves a text by dragging, and edits a selected one on click with the select tool", () => {
    const written = run(placed, type("Taşı"), commitText, tool("select"));
    const moved = run(written, press(35, 45), drag(85, 95), release);
    expect(present(moved)[0]).toMatchObject({ at: { x: 80, y: 90 } });
    expect(moved.gesture).toBeNull();
    expect(run(moved, press(85, 95), release).gesture).toMatchObject({ type: "editing" });
  });

  it("applies style changes to the text being edited", () => {
    const s = run(placed, { type: "setSize", size: 2 }, type("Büyük"), commitText);
    expect(present(s)[0]).toMatchObject({ fontSize: 32 });
  });

  it("commits the edit when the tool changes", () => {
    const s = run(placed, type("Son"), tool("arrow"));
    expect(present(s)[0]).toMatchObject({ text: "Son" });
    expect(s.tool).toBe("arrow");
  });
});

describe("undo and redo", () => {
  const three = gesture(gesture(withArrow, [0, 200], [100, 290]), [200, 200], [300, 250]);

  it("steps back and forward through the history", () => {
    expect(present(three)).toHaveLength(3);
    const back = run(three, { type: "undo" }, { type: "undo" });
    expect(present(back)).toHaveLength(1);
    expect(canRedo(back)).toBe(true);
    const forward = run(back, { type: "redo" });
    expect(present(forward)).toHaveLength(2);
    expect(present(run(forward, { type: "redo" }))).toEqual(present(three));
  });

  it("clears the redo stack on a new change", () => {
    const branched = gesture(run(three, { type: "undo" }), [10, 10], [50, 10]);
    expect(canRedo(branched)).toBe(false);
    expect(present(branched)).toHaveLength(3);
  });

  it("deselects an annotation that undo removed", () => {
    expect(three.selected).toBe(3);
    expect(run(three, { type: "undo" }).selected).toBeNull();
  });

  it("ignores undo during a drag and at the start of the history", () => {
    const dragging = run(three, press(250, 225), drag(260, 230));
    expect(run(dragging, { type: "undo" })).toBe(dragging);
    expect(run(INITIAL_ANNOTATE, { type: "undo" }, { type: "redo" })).toBe(INITIAL_ANNOTATE);
  });

  it("undoes moves and deletions", () => {
    const moved = run(withArrow, press(60, 45), drag(60, 145), release);
    const deleted = run(moved, { type: "delete" });
    const restored = run(deleted, { type: "undo" });
    expect(present(restored)[0]).toMatchObject({ from: { x: 10, y: 120 } });
    expect(present(run(restored, { type: "undo" }))[0]).toMatchObject({ from: { x: 10, y: 20 } });
  });
});

describe("rebase", () => {
  it("shifts the whole history so undo stays on the same pixels", () => {
    const moved = run(withArrow, press(60, 45), drag(60, 145), release);
    const rebased = run(moved, { type: "rebase", dx: -10, dy: 20 });
    expect(present(rebased)[0]).toMatchObject({ from: { x: 0, y: 140 } });
    expect(present(run(rebased, { type: "undo" }))[0]).toMatchObject({ from: { x: 0, y: 40 } });
    expect(run(moved, { type: "rebase", dx: 0, dy: 0 })).toBe(moved);
  });
});
