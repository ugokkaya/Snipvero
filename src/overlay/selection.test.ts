import { describe, expect, it } from "vitest";
import type { Point } from "./coords";
import {
  IDLE,
  cursorFor,
  hitTest,
  reduceSelection,
  selectedRegion,
  spaceFor,
  type SelectionAction,
  type SelectionState,
} from "./selection";

// A 1920×1080 frame at 1×: grab 8 px, slop 3 px.
const SPACE = spaceFor({ width: 1920, height: 1080 }, { width: 1920, height: 1080 });

const press = (x: number, y: number): SelectionAction => ({ type: "press", point: { x, y } });
const drag = (x: number, y: number): SelectionAction => ({ type: "drag", point: { x, y } });
const release: SelectionAction = { type: "release" };

function run(state: SelectionState, ...actions: SelectionAction[]): SelectionState {
  return actions.reduce((s, a) => reduceSelection(s, a, SPACE), state);
}

/** Press, drag in steps and release: a whole gesture. */
function gesture(state: SelectionState, from: Point, ...to: Point[]): SelectionState {
  return run(state, press(from.x, from.y), ...to.map((p) => drag(p.x, p.y)), release);
}

const select = (x: number, y: number, width: number, height: number) =>
  gesture(IDLE, { x, y }, { x: x + width, y: y + height });

describe("spaceFor", () => {
  it("converts pointer tolerances to pixels per display", () => {
    expect(SPACE).toEqual({ width: 1920, height: 1080, grab: 8, slop: 3 });
    expect(spaceFor({ width: 1512, height: 982 }, { width: 3024, height: 1964 })).toEqual({
      width: 3024,
      height: 1964,
      grab: 16,
      slop: 6,
    });
  });
});

describe("creating a selection", () => {
  const expected = { x: 100, y: 200, width: 300, height: 150 };

  it.each([
    ["down-right", { x: 100, y: 200 }, { x: 400, y: 350 }],
    ["up-left", { x: 400, y: 350 }, { x: 100, y: 200 }],
    ["down-left", { x: 400, y: 200 }, { x: 100, y: 350 }],
    ["up-right", { x: 100, y: 350 }, { x: 400, y: 200 }],
  ])("drags %s", (_, from, to) => {
    expect(selectedRegion(gesture(IDLE, from, to))).toEqual(expected);
  });

  it("goes idle → creating → selected", () => {
    const creating = run(IDLE, press(10, 10), drag(50, 60));
    expect(creating).toMatchObject({
      phase: "creating",
      dragged: true,
      rect: { x: 10, y: 10, width: 40, height: 50 },
    });
    expect(selectedRegion(creating)).toBeNull();
    expect(run(creating, release).phase).toBe("selected");
  });

  it("tracks a drag that reverses through the anchor", () => {
    const state = gesture(IDLE, { x: 500, y: 500 }, { x: 600, y: 600 }, { x: 400, y: 450 });
    expect(selectedRegion(state)).toEqual({ x: 400, y: 450, width: 100, height: 50 });
  });

  it("treats a click (within the slop) as no selection", () => {
    expect(gesture(IDLE, { x: 10, y: 10 })).toEqual(IDLE);
    expect(gesture(IDLE, { x: 10, y: 10 }, { x: 13, y: 12 })).toEqual(IDLE);
  });

  it("never finalizes a zero-width or zero-height region", () => {
    // Dragged far, but back onto a line.
    expect(gesture(IDLE, { x: 10, y: 10 }, { x: 300, y: 300 }, { x: 300, y: 10 })).toEqual(IDLE);
  });

  it("keeps small selections once dragged", () => {
    expect(
      selectedRegion(gesture(IDLE, { x: 10, y: 10 }, { x: 30, y: 30 }, { x: 12, y: 11 })),
    ).toEqual({
      x: 10,
      y: 10,
      width: 2,
      height: 1,
    });
  });

  it("clamps to the display, including edge-aligned and full-screen selections", () => {
    expect(selectedRegion(gesture(IDLE, { x: 1800, y: 1000 }, { x: 5000, y: 5000 }))).toEqual({
      x: 1800,
      y: 1000,
      width: 120,
      height: 80,
    });
    expect(
      selectedRegion(gesture(IDLE, { x: 0, y: 0 }, { x: -50, y: -50 }, { x: 1920, y: 1080 })),
    ).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it("starts a new selection when dragging outside the current one", () => {
    const first = select(100, 100, 200, 200);
    const second = gesture(first, { x: 1000, y: 500 }, { x: 1100, y: 600 });
    expect(selectedRegion(second)).toEqual({ x: 1000, y: 500, width: 100, height: 100 });
  });

  it("keeps the current selection on a click outside it", () => {
    const first = select(100, 100, 200, 200);
    expect(gesture(first, { x: 1000, y: 500 })).toEqual(first);
  });
});

describe("hitTest", () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it("finds corners, edges, inside and outside", () => {
    expect(hitTest(rect, { x: 100, y: 100 }, 8)).toBe("nw");
    expect(hitTest(rect, { x: 305, y: 205 }, 8)).toBe("se");
    expect(hitTest(rect, { x: 300, y: 100 }, 8)).toBe("ne");
    expect(hitTest(rect, { x: 95, y: 200 }, 8)).toBe("sw");
    expect(hitTest(rect, { x: 200, y: 96 }, 8)).toBe("n");
    expect(hitTest(rect, { x: 200, y: 204 }, 8)).toBe("s");
    expect(hitTest(rect, { x: 94, y: 150 }, 8)).toBe("w");
    expect(hitTest(rect, { x: 306, y: 150 }, 8)).toBe("e");
    expect(hitTest(rect, { x: 200, y: 150 }, 8)).toBe("inside");
    expect(hitTest(rect, { x: 91, y: 150 }, 8)).toBe("outside");
    expect(hitTest(rect, { x: 200, y: 209 }, 8)).toBe("outside");
  });

  it("leaves a move area inside tiny selections", () => {
    const tiny = { x: 100, y: 100, width: 4, height: 4 };
    expect(hitTest(tiny, { x: 102, y: 102 }, 8)).toBe("inside");
    expect(hitTest(tiny, { x: 96, y: 96 }, 8)).toBe("nw");
    expect(hitTest(tiny, { x: 108, y: 102 }, 8)).toBe("e");
  });
});

describe("moving", () => {
  const start = select(100, 100, 200, 100);

  it("goes selected → moving → selected and keeps the size", () => {
    const moving = run(start, press(150, 150), drag(160, 170));
    expect(moving).toMatchObject({
      phase: "moving",
      rect: { x: 110, y: 120, width: 200, height: 100 },
    });
    expect(selectedRegion(run(moving, release))).toEqual({
      x: 110,
      y: 120,
      width: 200,
      height: 100,
    });
  });

  it("stops at every display edge without shrinking", () => {
    expect(selectedRegion(gesture(start, { x: 150, y: 150 }, { x: -500, y: -500 }))).toEqual({
      x: 0,
      y: 0,
      width: 200,
      height: 100,
    });
    expect(selectedRegion(gesture(start, { x: 150, y: 150 }, { x: 5000, y: 5000 }))).toEqual({
      x: 1720,
      y: 980,
      width: 200,
      height: 100,
    });
  });

  it("a press without movement leaves the selection unchanged", () => {
    expect(gesture(start, { x: 150, y: 150 })).toEqual(start);
  });

  it("keeps the same region object when an edit ends where it started", () => {
    // The overlay reports a region to Rust when its identity changes; equal values must not.
    const region = selectedRegion(start);
    expect(selectedRegion(gesture(start, { x: 150, y: 150 }, { x: 150, y: 150 }))).toBe(region);
    expect(
      selectedRegion(gesture(start, { x: 150, y: 150 }, { x: 170, y: 150 }, { x: 150, y: 150 })),
    ).toBe(region);
    expect(selectedRegion(gesture(start, { x: 300, y: 150 }, { x: 300, y: 150 }))).toBe(region);
    expect(selectedRegion(gesture(start, { x: 1000, y: 900 }))).toBe(region);
    const dragging = run(start, press(150, 150), drag(160, 150));
    expect(run(dragging, drag(160, 150))).toBe(dragging);
  });
});

describe("resizing", () => {
  const start = select(100, 100, 200, 100); // right edge 300, bottom 200

  it("resizes from each corner and edge", () => {
    expect(selectedRegion(gesture(start, { x: 300, y: 200 }, { x: 350, y: 260 }))).toEqual({
      x: 100,
      y: 100,
      width: 250,
      height: 160,
    });
    expect(selectedRegion(gesture(start, { x: 100, y: 100 }, { x: 80, y: 90 }))).toEqual({
      x: 80,
      y: 90,
      width: 220,
      height: 110,
    });
    expect(selectedRegion(gesture(start, { x: 200, y: 100 }, { x: 260, y: 50 }))).toEqual({
      x: 100,
      y: 50,
      width: 200,
      height: 150,
    });
    expect(selectedRegion(gesture(start, { x: 300, y: 150 }, { x: 250, y: 999 }))).toEqual({
      x: 100,
      y: 100,
      width: 150,
      height: 100,
    });
  });

  it("keeps the grab offset when an edge is grabbed from just outside", () => {
    expect(selectedRegion(gesture(start, { x: 305, y: 150 }, { x: 315, y: 150 }))).toEqual({
      x: 100,
      y: 100,
      width: 210,
      height: 100,
    });
  });

  it("flips when an edge is dragged past the opposite one", () => {
    expect(selectedRegion(gesture(start, { x: 300, y: 150 }, { x: 40, y: 150 }))).toEqual({
      x: 40,
      y: 100,
      width: 60,
      height: 100,
    });
  });

  it("clamps resized edges to the display", () => {
    expect(selectedRegion(gesture(start, { x: 300, y: 200 }, { x: 9000, y: 9000 }))).toEqual({
      x: 100,
      y: 100,
      width: 1820,
      height: 980,
    });
    expect(selectedRegion(gesture(start, { x: 100, y: 100 }, { x: -9000, y: -9000 }))).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });

  it("restores the previous region when squeezed to zero size", () => {
    expect(gesture(start, { x: 300, y: 150 }, { x: 100, y: 150 })).toEqual(start);
  });

  it("reports the resize phase and cursor while dragging", () => {
    const resizing = run(start, press(300, 200), drag(310, 210));
    expect(resizing).toMatchObject({ phase: "resizing", handle: "se" });
    expect(cursorFor(resizing, "outside")).toBe("nwse-resize");
  });
});

describe("Retina", () => {
  const retina = spaceFor({ width: 1512, height: 982 }, { width: 3024, height: 1964 });
  const run2 = (state: SelectionState, ...actions: SelectionAction[]) =>
    actions.reduce((s, a) => reduceSelection(s, a, retina), state);

  it("clamps to the physical frame and uses scaled tolerances", () => {
    const state = run2(IDLE, press(3000, 1900), drag(4000, 4000), release);
    expect(selectedRegion(state)).toEqual({ x: 3000, y: 1900, width: 24, height: 64 });
    // 12 px outside the left edge is within the 16 px Retina grab distance (8 CSS px).
    expect(run2(state, press(2988, 1932))).toMatchObject({ phase: "resizing", handle: "w" });
    // A 5 px drag is still a click at 2× (slop 6 px).
    expect(run2(IDLE, press(10, 10), drag(15, 15), release)).toEqual(IDLE);
  });
});

describe("clear and cancel", () => {
  const selected = select(100, 100, 200, 100);

  it("clears when another display takes the selection, from any phase", () => {
    expect(run(selected, { type: "clear" })).toEqual(IDLE);
    expect(run(selected, press(150, 150), drag(200, 200), { type: "clear" })).toEqual(IDLE);
  });

  it("Escape cancels from any phase and ignores later input", () => {
    for (const state of [
      IDLE,
      selected,
      run(IDLE, press(1, 1), drag(50, 50)),
      run(selected, press(300, 200)),
    ]) {
      const cancelled = run(state, { type: "cancel" });
      expect(cancelled).toEqual({ phase: "cancelled" });
      expect(run(cancelled, press(10, 10), drag(500, 500), release, { type: "clear" })).toEqual(
        cancelled,
      );
    }
  });
});

describe("cursorFor", () => {
  const selected = select(100, 100, 200, 100);

  it("uses a crosshair to create and move/resize cursors over the selection", () => {
    expect(cursorFor(IDLE, "outside")).toBe("crosshair");
    expect(cursorFor(selected, "outside")).toBe("crosshair");
    expect(cursorFor(selected, "inside")).toBe("move");
    expect(cursorFor(selected, "ne")).toBe("nesw-resize");
    expect(cursorFor(selected, "w")).toBe("ew-resize");
    expect(cursorFor(run(selected, press(150, 150)), "outside")).toBe("move");
  });
});
