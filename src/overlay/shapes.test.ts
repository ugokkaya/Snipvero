import { describe, expect, it } from "vitest";
import { FONT_FAMILY, LINE_HEIGHT, arrowGeometry, type Annotation } from "./annotations";
import { annotationShapes } from "./shapes";

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
    expect(head?.config).toMatchObject({
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
    expect(shapes[0]?.config).not.toHaveProperty("fill");
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
    expect(outside[0]?.config).toMatchObject({
      points: [-50, -50, expect.any(Number), expect.any(Number)],
    });
  });
});
