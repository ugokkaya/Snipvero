import { describe, expect, it } from "vitest";
import { FONT_FAMILY, LINE_HEIGHT, arrowGeometry, type Annotation } from "./annotations";
import { annotationShapes, type ShapeSpec } from "./shapes";

/** The Konva config of a shape that has one (everything but a mosaic). */
const configOf = (spec: ShapeSpec | undefined) =>
  spec && spec.type !== "mosaic" ? spec.config : undefined;

const arrow: Annotation = {
  kind: "arrow",
  id: 1,
  color: "#ff3b30",
  width: 8,
  from: { x: 10, y: 20 },
  to: { x: 110, y: 20 },
};

describe("annotationShapes", () => {
  it("draws an arrow as a round-capped shaft and a filled head, in frame pixels", () => {
    const [shaft, head] = annotationShapes(arrow);
    const geometry = arrowGeometry(arrow);
    expect(shaft).toEqual({
      type: "line",
      config: { points: geometry.shaft, stroke: "#ff3b30", strokeWidth: 8, lineCap: "round" },
    });
    expect(head?.type).toBe("line");
    expect(configOf(head)).toMatchObject({
      points: geometry.head,
      closed: true,
      fill: "#ff3b30",
      strokeWidth: 4,
    });
  });

  it("draws an outlined rectangle with its colour and stroke width", () => {
    const shapes = annotationShapes({
      kind: "rect",
      id: 2,
      color: "#0a84ff",
      width: 4,
      rect: { x: 5, y: 6, width: 70, height: 40 },
    });
    expect(shapes).toEqual([
      {
        type: "rect",
        config: {
          x: 5,
          y: 6,
          width: 70,
          height: 40,
          stroke: "#0a84ff",
          strokeWidth: 4,
          lineJoin: "miter",
        },
      },
    ]);
    expect(configOf(shapes[0])).not.toHaveProperty("fill");
  });

  it("draws text with the editor's font, size and line height, Unicode unchanged", () => {
    const text = "Çığır öğüş\nİı Şş";
    const [shape] = annotationShapes({
      kind: "text",
      id: 3,
      color: "#ffffff",
      fontSize: 40,
      at: { x: -12, y: 30 },
      text,
    });
    expect(shape).toEqual({
      type: "text",
      config: {
        x: -12,
        y: 30,
        text,
        fontSize: 40,
        fontFamily: FONT_FAMILY,
        lineHeight: LINE_HEIGHT,
        fill: "#ffffff",
      },
    });
  });

  it("keeps coordinates outside the region, so the layer edge clips them like the preview", () => {
    const outside = annotationShapes({ ...arrow, from: { x: -50, y: -50 } });
    expect(configOf(outside[0])).toMatchObject({
      points: [-50, -50, expect.any(Number), expect.any(Number)],
    });
  });
});

describe("fill, highlight and blur shapes", () => {
  const rect = { x: 5, y: 6, width: 70, height: 40 };

  it("covers a fill with its colour, opaque and without an outline", () => {
    const [shape] = annotationShapes({ kind: "fill", id: 1, color: "#000000", rect });
    expect(configOf(shape)).toEqual({ ...rect, fill: "#000000" });
  });

  it("draws a highlight translucent, so the screenshot shows through", () => {
    const [shape] = annotationShapes({ kind: "highlight", id: 2, color: "#ffcc00", rect });
    expect(configOf(shape)).toEqual({ ...rect, fill: "#ffcc00", opacity: 0.4 });
  });

  it("leaves a blur to the renderers, which cut it from the frame", () => {
    const blur = { kind: "blur", id: 3, block: 10, rect } as const;
    expect(annotationShapes(blur)).toEqual([{ type: "mosaic", blur }]);
  });
});
