// Konva's core plus the three shapes used, instead of every shape and filter (about half the size).
import "konva/lib/shapes/Line";
import "konva/lib/shapes/Rect";
import "konva/lib/shapes/Text";
import { Group, Layer, Line, Rect as KonvaRect, Stage, Text } from "react-konva/lib/ReactKonvaCore";
import { annotationBounds, type Annotation, type MeasureLine } from "./annotations";
import { pixelRatio, pixelToClient, type Point, type Rect, type Size } from "./coords";
import { annotationShapes } from "./shapes";

const ACCENT = "#6e6af0";
/** Selection marks in CSS pixels. */
const HANDLE_CSS = 7;
const DASH_CSS = [4, 3];
const MARGIN_CSS = 4;

interface Props {
  /** The region in frame pixels; the stage covers exactly this, so it also clips. */
  region: Rect;
  /** Frame pixel position annotation coordinates are relative to. */
  origin: Point;
  view: Size;
  frame: Size;
  scale: number;
  annotations: readonly Annotation[];
  selected: Annotation | null;
  measure: MeasureLine;
}

/**
 * Draws the annotations over the frozen frame with Konva. Visual only: hit testing is in the pure
 * models. The layer is scaled so shapes are drawn in frame pixels; Konva's canvas uses the device
 * pixel ratio, so lines stay sharp on Retina displays. Export draws the same shapes (rasterize.ts).
 */
export function AnnotationLayer(props: Props) {
  const { region, origin, view, frame, scale, annotations, selected, measure } = props;
  const css = pixelToClient(region, view, frame);
  if (css.width <= 0 || css.height <= 0) return null;
  const ratio = pixelRatio(view, frame);
  return (
    <Stage
      className="annotations"
      style={{ left: css.x, top: css.y }}
      width={css.width}
      height={css.height}
      listening={false}
    >
      <Layer scaleX={1 / ratio.x} scaleY={1 / ratio.y} listening={false}>
        <Group x={origin.x - region.x} y={origin.y - region.y}>
          {annotations.map((a) => (
            <Shape key={a.id} annotation={a} />
          ))}
          {selected && <SelectionMarks annotation={selected} scale={scale} measure={measure} />}
        </Group>
      </Layer>
    </Stage>
  );
}

function Shape({ annotation }: { annotation: Annotation }) {
  return (
    <>
      {annotationShapes(annotation).map((spec, i) => {
        switch (spec.type) {
          case "line":
            return <Line key={i} {...spec.config} />;
          case "rect":
            return <KonvaRect key={i} {...spec.config} />;
          case "text":
            return <Text key={i} {...spec.config} />;
        }
      })}
    </>
  );
}

function SelectionMarks(props: { annotation: Annotation; scale: number; measure: MeasureLine }) {
  const { annotation: a, scale, measure } = props;
  const line = { stroke: ACCENT, strokeWidth: scale };
  if (a.kind === "rect") {
    const { x, y, width, height } = a.rect;
    const size = HANDLE_CSS * scale;
    const xs = [x, x + width / 2, x + width];
    const ys = [y, y + height / 2, y + height];
    const handles = ys.flatMap((hy, row) =>
      xs
        .map((hx, col) => ({ hx, hy, key: `${row}${col}` }))
        .filter((_, col) => row !== 1 || col !== 1),
    );
    return (
      <>
        {handles.map(({ hx, hy, key }) => (
          <KonvaRect
            key={key}
            x={hx - size / 2}
            y={hy - size / 2}
            width={size}
            height={size}
            fill="#fff"
            {...line}
          />
        ))}
      </>
    );
  }
  const margin = MARGIN_CSS * scale;
  const b = annotationBounds(a, measure);
  return (
    <KonvaRect
      x={b.x - margin}
      y={b.y - margin}
      width={b.width + 2 * margin}
      height={b.height + 2 * margin}
      dash={DASH_CSS.map((d) => d * scale)}
      {...line}
    />
  );
}
