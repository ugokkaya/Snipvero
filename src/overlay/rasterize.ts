// Rasterizes the annotations for export, at the frame's physical resolution. Loaded lazily with
// Konva, like AnnotationLayer. A detached Konva group is drawn into one canvas of exactly the
// region's pixel size: no stage, so no device-pixel-ratio or hit-test buffers are allocated.
// Konva's core first, as in AnnotationLayer: the shapes rely on its globals being set up.
import Konva from "konva/lib/Core";
import { Line } from "konva/lib/shapes/Line";
import { Rect } from "konva/lib/shapes/Rect";
import { Text } from "konva/lib/shapes/Text";
import type { LayerPlan } from "./exporting";
import { annotationShapes, type ShapeSpec } from "./shapes";

function node(spec: ShapeSpec) {
  switch (spec.type) {
    case "line":
      return new Line(spec.config);
    case "rect":
      return new Rect(spec.config);
    case "text":
      return new Text(spec.config);
  }
}

/** Straight-alpha RGBA of the plan's size, ready to be blended over the crop in Rust. */
export function rasterize(plan: LayerPlan): Uint8Array {
  const group = new Konva.Group({ ...plan.offset, listening: false });
  try {
    for (const annotation of plan.annotations) {
      for (const spec of annotationShapes(annotation)) group.add(node(spec));
    }
    const canvas = group.toCanvas({
      x: 0,
      y: 0,
      width: plan.width,
      height: plan.height,
      pixelRatio: 1,
    });
    const context = canvas.getContext("2d");
    if (!context || canvas.width !== plan.width || canvas.height !== plan.height) {
      throw new Error("could not draw the annotations");
    }
    const { data } = context.getImageData(0, 0, plan.width, plan.height);
    // Release the canvas backing store now rather than at garbage collection.
    canvas.width = canvas.height = 0;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } finally {
    group.destroy();
  }
}
