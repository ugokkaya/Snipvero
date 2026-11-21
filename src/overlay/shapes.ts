// Konva shape configurations for each annotation, shared by the on-screen layer and the export
// rasterizer (rasterize.ts), so the copied or saved image is drawn exactly like the preview.
// Pure: only Konva's types are imported.

import type { LineConfig } from "konva/lib/shapes/Line";
import type { RectConfig } from "konva/lib/shapes/Rect";
import type { TextConfig } from "konva/lib/shapes/Text";
import {
  FONT_FAMILY,
  HIGHLIGHT_OPACITY,
  LINE_HEIGHT,
  arrowGeometry,
  type Annotation,
  type BlurAnnotation,
} from "./annotations";

export type ShapeSpec =
  | { type: "line"; config: LineConfig }
  | { type: "rect"; config: RectConfig }
  | { type: "text"; config: TextConfig }
  /** Mosaic of the screenshot: it needs the frame's pixels, so the renderers draw it themselves. */
  | { type: "mosaic"; blur: BlurAnnotation };

/** Shapes in drawing order, in the annotation's own coordinates (frame pixels). */
export function annotationShapes(a: Annotation): ShapeSpec[] {
  switch (a.kind) {
    case "arrow": {
      const { shaft, head } = arrowGeometry(a);
      return [
        {
          type: "line",
          config: { points: shaft, stroke: a.color, strokeWidth: a.width, lineCap: "round" },
        },
        {
          type: "line",
          config: {
            points: head,
            closed: true,
            fill: a.color,
            stroke: a.color,
            strokeWidth: a.width / 2,
            lineJoin: "round",
          },
        },
      ];
    }
    case "rect":
      return [
        {
          type: "rect",
          config: { ...a.rect, stroke: a.color, strokeWidth: a.width, lineJoin: "miter" },
        },
      ];
    case "fill":
      return [{ type: "rect", config: { ...a.rect, fill: a.color } }];
    case "highlight":
      return [{ type: "rect", config: { ...a.rect, fill: a.color, opacity: HIGHLIGHT_OPACITY } }];
    case "blur":
      return [{ type: "mosaic", blur: a }];
    case "text":
      return [
        {
          type: "text",
          config: {
            ...a.at,
            text: a.text,
            fontSize: a.fontSize,
            fontFamily: FONT_FAMILY,
            lineHeight: LINE_HEIGHT,
            fill: a.color,
          },
        },
      ];
  }
}
