import { FONT_FAMILY, type MeasureLine } from "./annotations";

let context: CanvasRenderingContext2D | null = null;

/** Measures with the same font string Konva uses, so hit boxes match the drawn text. */
export const measureLine: MeasureLine = (line, size) => {
  context ??= document.createElement("canvas").getContext("2d");
  if (!context) return line.length * size * 0.6;
  context.font = `normal normal ${size}px ${FONT_FAMILY}`;
  return context.measureText(line).width;
};
