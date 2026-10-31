import { frameRgba } from "./ipc";

/** Loads a captured frame as a GPU-ready bitmap: raw RGBA over IPC → ImageData (ADR-007). */
export async function loadFrame(
  index: number,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const rgba = new Uint8ClampedArray(await frameRgba(index));
  return createImageBitmap(new ImageData(rgba, width, height));
}
