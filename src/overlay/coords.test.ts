import { describe, expect, it } from "vitest";
import {
  clientToPixel,
  pixelRatio,
  pixelToClient,
  placeLabel,
  placeOutside,
  spanRect,
} from "./coords";
import { TOOLBAR_SIZE } from "./Toolbar";

// The original test setup: built-in Retina at the origin, 1× displays left (negative x) and right.
const RETINA = {
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  frame: { width: 3024, height: 1964 },
};
const LEFT = {
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  frame: { width: 1920, height: 1080 },
};
// 2560×1440 panel at 1.5× ("looks like 1706.67 × 960"), above the primary.
const FRACTIONAL = {
  bounds: { x: 0, y: -960, width: 2560 / 1.5, height: 960 },
  frame: { width: 2560, height: 1440 },
};

describe("pixelRatio", () => {
  it("is the per-display scale, not a global one", () => {
    expect(pixelRatio(RETINA.bounds, RETINA.frame)).toEqual({ x: 2, y: 2 });
    expect(pixelRatio(LEFT.bounds, LEFT.frame)).toEqual({ x: 1, y: 1 });
    expect(pixelRatio(FRACTIONAL.bounds, FRACTIONAL.frame).y).toBe(1.5);
  });
});

describe("clientToPixel", () => {
  it("scales Retina pointer positions to physical pixels", () => {
    expect(clientToPixel({ x: 100, y: 50.5 }, RETINA.bounds, RETINA.frame)).toEqual({
      x: 200,
      y: 101,
    });
  });

  it("is window-local, so negative display origins do not matter", () => {
    expect(clientToPixel({ x: 0, y: 0 }, LEFT.bounds, LEFT.frame)).toEqual({ x: 0, y: 0 });
    expect(clientToPixel({ x: 1919.6, y: 3 }, LEFT.bounds, LEFT.frame)).toEqual({ x: 1920, y: 3 });
  });

  it("rounds fractional scales to whole pixels", () => {
    expect(clientToPixel({ x: 10.2, y: 10 }, FRACTIONAL.bounds, FRACTIONAL.frame)).toEqual({
      x: 15,
      y: 15,
    });
    expect(clientToPixel({ x: 2560 / 1.5, y: 960 }, FRACTIONAL.bounds, FRACTIONAL.frame)).toEqual({
      x: 2560,
      y: 1440,
    });
  });

  it("clamps positions outside the window (captured drags) to the display edges", () => {
    expect(clientToPixel({ x: -40, y: 2000 }, RETINA.bounds, RETINA.frame)).toEqual({
      x: 0,
      y: 1964,
    });
  });
});

describe("pixelToClient", () => {
  const region = { x: 200, y: 100, width: 401, height: 300 };

  it("converts pixel regions back to CSS pixels for drawing", () => {
    expect(pixelToClient(region, RETINA.bounds, RETINA.frame)).toEqual({
      x: 100,
      y: 50,
      width: 200.5,
      height: 150,
    });
    expect(pixelToClient(region, LEFT.bounds, LEFT.frame)).toEqual(region);
    expect(pixelToClient(region, FRACTIONAL.bounds, FRACTIONAL.frame).height).toBe(200);
  });

  it("round-trips pointer positions on every display", () => {
    for (const { bounds, frame } of [RETINA, LEFT, FRACTIONAL]) {
      const pixel = clientToPixel({ x: 300, y: 200 }, bounds, frame);
      const back = pixelToClient({ ...pixel, width: 0, height: 0 }, bounds, frame);
      expect(back.x).toBeCloseTo(300);
      expect(back.y).toBeCloseTo(200);
    }
  });
});

describe("spanRect", () => {
  it("normalizes drags in all four directions", () => {
    const expected = { x: 10, y: 20, width: 30, height: 40 };
    expect(spanRect({ x: 10, y: 20 }, { x: 40, y: 60 })).toEqual(expected); // down-right
    expect(spanRect({ x: 40, y: 60 }, { x: 10, y: 20 })).toEqual(expected); // up-left
    expect(spanRect({ x: 40, y: 20 }, { x: 10, y: 60 })).toEqual(expected); // down-left
    expect(spanRect({ x: 10, y: 60 }, { x: 40, y: 20 })).toEqual(expected); // up-right
  });
});

describe("placeOutside", () => {
  const view = { width: 1000, height: 800 };
  const box = { width: 100, height: 20 };

  it("uses the preferred side when it fits", () => {
    const rect = { x: 50, y: 100, width: 200, height: 200 };
    expect(placeOutside(rect, box, view, 6, "above")).toEqual({ x: 50, y: 74 });
    expect(placeOutside(rect, box, view, 6, "below")).toEqual({ x: 50, y: 306 });
  });

  it("switches sides at the top and bottom edges", () => {
    expect(placeOutside({ x: 0, y: 0, width: 50, height: 50 }, box, view, 6, "above")).toEqual({
      x: 0,
      y: 56,
    });
    expect(placeOutside({ x: 0, y: 700, width: 50, height: 100 }, box, view, 6, "below")).toEqual({
      x: 0,
      y: 674,
    });
  });

  it("goes inside a full-height selection and stays on screen horizontally", () => {
    expect(placeOutside({ x: 950, y: 0, width: 50, height: 800 }, box, view, 6, "above")).toEqual({
      x: 900,
      y: 774,
    });
  });
});

describe("toolbar placement", () => {
  const view = RETINA.bounds;
  const place = (rect: { x: number; y: number; width: number; height: number }) =>
    placeOutside(rect, TOOLBAR_SIZE, view, 8, "below");

  it("goes below the selection, aligned with its left edge", () => {
    expect(place({ x: 100, y: 100, width: 300, height: 200 })).toEqual({ x: 100, y: 308 });
  });

  it("goes above a selection that reaches the bottom of the screen", () => {
    expect(place({ x: 100, y: 500, width: 300, height: 482 })).toEqual({
      x: 100,
      y: 500 - 8 - TOOLBAR_SIZE.height,
    });
  });

  it("goes inside a full-screen selection", () => {
    expect(place({ x: 0, y: 0, width: 1512, height: 982 })).toEqual({
      x: 0,
      y: 982 - 8 - TOOLBAR_SIZE.height,
    });
  });

  it("stays on screen near the right edge, even for a tiny selection", () => {
    const p = place({ x: 1500, y: 100, width: 4, height: 4 });
    expect(p).toEqual({ x: 1512 - TOOLBAR_SIZE.width, y: 112 });
    // Wider than the smallest selection, but never wider than a display.
    expect(TOOLBAR_SIZE.width).toBeLessThan(800);
  });
});

describe("placeLabel", () => {
  const view = RETINA.bounds;
  const label = { width: 80, height: 22 };

  it("stays above the selection when the toolbar is below", () => {
    const rect = { x: 100, y: 100, width: 300, height: 200 };
    const toolbar = { ...placeOutside(rect, TOOLBAR_SIZE, view, 8, "below"), ...TOOLBAR_SIZE };
    expect(placeLabel(rect, label, view, 6, toolbar)).toEqual({ x: 100, y: 72 });
  });

  it("stacks above the toolbar when both would be above the selection", () => {
    const rect = { x: 100, y: 500, width: 300, height: 482 };
    const toolbar = { ...placeOutside(rect, TOOLBAR_SIZE, view, 8, "below"), ...TOOLBAR_SIZE };
    const p = placeLabel(rect, label, view, 6, toolbar);
    expect(p.y + label.height).toBeLessThanOrEqual(toolbar.y);
  });

  it("goes below the toolbar when there is no room above it", () => {
    const rect = { x: 0, y: 50, width: 400, height: 932 };
    const toolbar = { ...placeOutside(rect, TOOLBAR_SIZE, view, 8, "below"), ...TOOLBAR_SIZE };
    expect(toolbar.y).toBe(6); // above the selection, squeezed to the top
    expect(placeLabel(rect, label, view, 6, toolbar).y).toBe(toolbar.y + toolbar.height + 6);
  });

  it("is unchanged without a toolbar", () => {
    const rect = { x: 100, y: 100, width: 300, height: 200 };
    expect(placeLabel(rect, label, view, 6, null)).toEqual(
      placeOutside(rect, label, view, 6, "above"),
    );
  });
});
