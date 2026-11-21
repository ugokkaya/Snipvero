import { describe, expect, it } from "vitest";
import { pixelate } from "./pixelate";

/** RGBA pixels from a list of [r, g, b, a], row by row. */
const rgba = (...px: [number, number, number, number][]) => new Uint8ClampedArray(px.flat());
const at = (data: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 4));

describe("pixelate", () => {
  it("fills each block with the average colour of its pixels", () => {
    const src = rgba([0, 0, 0, 255], [100, 50, 200, 255], [200, 100, 0, 255], [100, 50, 200, 255]);
    const out = pixelate(src, 2, 2, 2);
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ] as const) {
      expect(at(out, 2, x, y)).toEqual([100, 50, 100, 255]);
    }
  });

  it("starts blocks at the top-left corner and lets edge blocks be smaller", () => {
    // 3×1 with block 2: pixels 0 and 1 share a block; pixel 2 is a block of its own.
    const out = pixelate(rgba([0, 0, 0, 255], [100, 0, 0, 255], [40, 0, 0, 255]), 3, 1, 2);
    expect(at(out, 3, 0, 0)).toEqual([50, 0, 0, 255]);
    expect(at(out, 3, 1, 0)).toEqual([50, 0, 0, 255]);
    expect(at(out, 3, 2, 0)).toEqual([40, 0, 0, 255]);
  });

  it("does not change its input and returns an image of the same size", () => {
    const src = rgba([1, 2, 3, 255], [9, 8, 7, 255]);
    const copy = Uint8ClampedArray.from(src);
    expect(pixelate(src, 2, 1, 2)).toHaveLength(src.length);
    expect(src).toEqual(copy);
  });

  it("leaves nothing of the detail inside a block", () => {
    // A checkerboard of black and white becomes one flat grey: the pattern cannot be recovered.
    const px: [number, number, number, number][] = [];
    for (let i = 0; i < 16; i++) px.push(i % 2 === 0 ? [0, 0, 0, 255] : [254, 254, 254, 255]);
    const out = pixelate(rgba(...px), 4, 4, 4);
    expect(new Set(Array.from({ length: 16 }, (_, i) => out[i * 4])).size).toBe(1);
  });

  it("treats a block smaller than two pixels as two, so it always hides something", () => {
    const src = rgba([0, 0, 0, 255], [100, 0, 0, 255]);
    expect(at(pixelate(src, 2, 1, 1), 2, 0, 0)).toEqual([50, 0, 0, 255]);
  });

  it("handles an empty image and rejects data of the wrong size", () => {
    expect(pixelate(new Uint8ClampedArray(), 0, 0, 8)).toHaveLength(0);
    expect(() => pixelate(new Uint8ClampedArray(4), 2, 2, 2)).toThrow();
  });
});
