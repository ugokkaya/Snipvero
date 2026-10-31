import { describe, expect, it } from "vitest";
import {
  annotationAt,
  annotationBounds,
  arrowGeometry,
  distanceToSegment,
  fontSize,
  hitsAnnotation,
  strokeWidth,
  styleOf,
  textSize,
  translate,
  withStyle,
  type ArrowAnnotation,
  type MeasureLine,
  type RectAnnotation,
  type TextAnnotation,
} from "./annotations";

/** Every character is half the font size wide. */
const measure: MeasureLine = (line, size) => line.length * size * 0.5;

const arrow = (from: [number, number], to: [number, number], width = 4): ArrowAnnotation => ({
  kind: "arrow",
  id: 1,
  color: "#ff3b30",
  width,
  from: { x: from[0], y: from[1] },
  to: { x: to[0], y: to[1] },
});
const box: RectAnnotation = {
  kind: "rect",
  id: 2,
  color: "#0a84ff",
  width: 4,
  rect: { x: 100, y: 100, width: 200, height: 100 },
};
const text: TextAnnotation = {
  kind: "text",
  id: 3,
  color: "#ffffff",
  fontSize: 20,
  at: { x: 10, y: 20 },
  text: "Çığır\nöğüş İı",
};

describe("arrow geometry", () => {
  it("puts the tip on the end point and the head symmetric around the shaft", () => {
    const { shaft, head } = arrowGeometry(arrow([0, 0], [100, 0]));
    // Head length 3 × 4 + 6 = 18, half width 0.6 × 18.
    expect(head[0]).toBe(100);
    expect(head[1]).toBe(0);
    expect(head[2]).toBeCloseTo(82);
    expect(head[3]).toBeCloseTo(10.8);
    expect(head[4]).toBeCloseTo(82);
    expect(head[5]).toBeCloseTo(-10.8);
    // The shaft starts at the tail and ends inside the head, never past the tip.
    expect(shaft).toEqual([0, 0, 91, 0]);
  });

  it("follows the drag direction", () => {
    const { head } = arrowGeometry(arrow([100, 100], [100, 0]));
    expect(head[0]).toBe(100);
    expect(head[1]).toBe(0);
    expect(head[3]).toBeCloseTo(18); // the barbs sit below an upward tip
    expect(head[5]).toBeCloseTo(18);
  });

  it("shrinks the head to fit a short arrow and stays finite at zero length", () => {
    const short = arrowGeometry(arrow([0, 0], [5, 0]));
    expect(short.head[2]).toBeCloseTo(0);
    const none = arrowGeometry(arrow([7, 7], [7, 7]));
    expect([...none.shaft, ...none.head].every(Number.isFinite)).toBe(true);
  });

  it("scales the head with the stroke width", () => {
    const thin = arrowGeometry(arrow([0, 0], [200, 0], 2)).head[2];
    const thick = arrowGeometry(arrow([0, 0], [200, 0], 16)).head[2];
    expect(200 - thick).toBeGreaterThan(200 - thin);
  });
});

describe("hit testing", () => {
  it("grabs an arrow near its shaft only", () => {
    const a = arrow([0, 0], [100, 0]);
    expect(hitsAnnotation(a, { x: 50, y: 9 }, 8, measure)).toBe(true); // 8 + width / 2
    expect(hitsAnnotation(a, { x: 50, y: 11 }, 8, measure)).toBe(false);
    expect(hitsAnnotation(a, { x: 115, y: 0 }, 8, measure)).toBe(false);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });

  it("grabs an outlined rectangle by its border, not its inside", () => {
    expect(hitsAnnotation(box, { x: 100, y: 150 }, 8, measure)).toBe(true);
    expect(hitsAnnotation(box, { x: 90, y: 150 }, 8, measure)).toBe(true);
    expect(hitsAnnotation(box, { x: 200, y: 150 }, 8, measure)).toBe(false);
    expect(hitsAnnotation(box, { x: 80, y: 150 }, 8, measure)).toBe(false);
  });

  it("grabs a tiny rectangle anywhere on it", () => {
    const tiny = { ...box, rect: { x: 10, y: 10, width: 6, height: 6 } };
    expect(hitsAnnotation(tiny, { x: 13, y: 13 }, 8, measure)).toBe(true);
  });

  it("grabs a text by its box", () => {
    expect(hitsAnnotation(text, { x: 40, y: 60 }, 0, measure)).toBe(true);
    expect(hitsAnnotation(text, { x: 40, y: 80 }, 0, measure)).toBe(false);
  });

  it("returns the topmost annotation", () => {
    const over = { ...box, id: 9 };
    expect(annotationAt([box, over], { x: 100, y: 150 }, 8, measure)?.id).toBe(9);
    expect(annotationAt([box, over], { x: 0, y: 0 }, 8, measure)).toBeNull();
  });
});

describe("text", () => {
  it("measures Unicode and Turkish lines with the shared line height", () => {
    // "Çığır" and "öğüş İı" are 5 and 7 UTF-16 units: no surrogate pairs, one width each.
    expect(textSize(text.text, 20, measure)).toEqual({ width: 70, height: 50 });
    expect(annotationBounds(text, measure)).toEqual({ x: 10, y: 20, width: 70, height: 50 });
  });

  it("gives an empty text one line", () => {
    expect(textSize("", 20, measure)).toEqual({ width: 0, height: 25 });
  });
});

describe("bounds and moving", () => {
  it("includes half the stroke", () => {
    expect(annotationBounds(box, measure)).toEqual({ x: 98, y: 98, width: 204, height: 104 });
  });

  it("translates every kind and keeps unmoved objects", () => {
    expect(translate(box, 5, -5)).toMatchObject({ rect: { x: 105, y: 95, width: 200 } });
    expect(translate(text, 1, 2)).toMatchObject({ at: { x: 11, y: 22 } });
    expect(translate(arrow([0, 0], [10, 10]), 1, 1)).toMatchObject({
      from: { x: 1, y: 1 },
      to: { x: 11, y: 11 },
    });
    expect(translate(box, 0, 0)).toBe(box);
  });
});

describe("style presets", () => {
  it("are CSS sizes converted per display", () => {
    expect([0, 1, 2].map((s) => strokeWidth(s as 0 | 1 | 2, 1))).toEqual([2, 4, 8]);
    expect([0, 1, 2].map((s) => strokeWidth(s as 0 | 1 | 2, 2))).toEqual([4, 8, 16]);
    expect(strokeWidth(0, 0.4)).toBe(1); // never below one pixel
    expect(fontSize(1, 1)).toBe(20);
    expect(fontSize(1, 2)).toBe(40);
    expect(fontSize(1, 1.5)).toBe(30);
  });

  it("round-trips through styleOf", () => {
    const styled = withStyle(box, { color: "#34c759", size: 2 }, 2);
    expect(styled).toMatchObject({ color: "#34c759", width: 16 });
    expect(styleOf(styled, 2)).toEqual({ color: "#34c759", size: 2 });
    expect(styleOf(text, 1)).toEqual({ color: "#ffffff", size: 1 });
    expect(withStyle(box, { color: box.color, size: 1 }, 1)).toBe(box);
  });
});
