// Mosaic ("pixelate") blur on raw RGBA pixels. Pure: no canvas, so it is tested with plain arrays.
//
// The preview and the exported image both call this one function on the same frame pixels, so
// what the user sees is what is copied or saved. A mosaic cannot be reversed the way a light
// Gaussian blur sometimes can: every block keeps one average colour and nothing else.

/** Block edge below which a mosaic hides little; callers pass at least this. */
export const MIN_BLOCK = 2;

/**
 * Replaces each `block`×`block` cell of the image (cells start at the top-left corner; cells on
 * the right and bottom edges may be smaller) with the average colour of its pixels.
 * `pixels` is RGBA8 of `width`×`height`; a new array of the same size is returned.
 */
export function pixelate(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  block: number,
): Uint8ClampedArray<ArrayBuffer> {
  if (pixels.length !== width * height * 4) throw new Error("pixel data has an unexpected size");
  const size = Math.max(MIN_BLOCK, Math.floor(block));
  const out = new Uint8ClampedArray(pixels.length);
  for (let top = 0; top < height; top += size) {
    const bottom = Math.min(top + size, height);
    for (let left = 0; left < width; left += size) {
      const right = Math.min(left + size, width);
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          const i = (y * width + x) * 4;
          r += pixels[i] ?? 0;
          g += pixels[i + 1] ?? 0;
          b += pixels[i + 2] ?? 0;
          a += pixels[i + 3] ?? 0;
        }
      }
      const count = (bottom - top) * (right - left);
      const avg = [r, g, b, a].map((sum) => Math.round(sum / count));
      for (let y = top; y < bottom; y++) {
        for (let x = left; x < right; x++) {
          out.set(avg, (y * width + x) * 4);
        }
      }
    }
  }
  return out;
}
