import { describe, expect, it } from "vitest";
import { formatEstimate, GIF_FPS_CHOICES, gifFileName, gifWidthChoices, percent } from "./gif";

describe("gif choices", () => {
  it("offers the default and the maximum width, largest first, never above the maximum", () => {
    expect(gifWidthChoices(800, 600)).toEqual([800, 640, 600, 480, 320, 240]);
    // A small recording only gets its own widths.
    expect(gifWidthChoices(320, 320)).toEqual([320, 240]);
    // No duplicates when the default is a preset.
    expect(gifWidthChoices(800, 640)).toEqual([800, 640, 480, 320, 240]);
    expect(gifWidthChoices(100, 100)).toEqual([100]);
  });

  it("keeps the frame rates within the limit of 15", () => {
    expect(Math.max(...GIF_FPS_CHOICES)).toBe(15);
    expect(GIF_FPS_CHOICES).toContain(10);
  });

  it("words the estimate as an upper guess", () => {
    expect(formatEstimate(4_200_000)).toBe("up to about 4.2 MB");
  });

  it("suggests a gif file name in local time", () => {
    expect(gifFileName(new Date(2026, 9, 30, 14, 3, 9))).toBe("Snipvero-2026-10-30-140309.gif");
  });

  it("shows whole percents and never 100 before the end", () => {
    expect([0, 0.456, 0.999, 1, 2, -1].map(percent)).toEqual([0, 45, 99, 99, 99, 0]);
  });
});
