import { pixelToClient, placeLabel, type Rect, type Size } from "./coords";
import type { Handle } from "./selection";

const HANDLES: readonly Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

// The label is sized from its text rather than measured, so placing it needs no extra render.
const LABEL_HEIGHT = 22;
const LABEL_CHAR_WIDTH = 7.5;
const LABEL_PADDING = 16;
const LABEL_GAP = 6;

interface Props {
  /** Selection in frame pixels, or null for none. */
  rect: Rect | null;
  /** Window size in CSS pixels. */
  view: Size;
  /** Frame size in physical pixels. */
  frame: Size;
  handles: boolean;
  /** Where the toolbar is, in CSS pixels; the label keeps clear of it. */
  toolbar: Rect | null;
}

/** Dimmed surroundings, border, handles and size label. Purely visual: it takes no pointer input. */
export function SelectionView({ rect, view, frame, handles, toolbar }: Props) {
  if (!rect) return <div className="overlay-shade" />;
  const css = pixelToClient(rect, view, frame);
  const text = `${rect.width} × ${rect.height}`;
  const labelSize = { width: text.length * LABEL_CHAR_WIDTH + LABEL_PADDING, height: LABEL_HEIGHT };
  const label = placeLabel(css, labelSize, view, LABEL_GAP, toolbar);
  return (
    <>
      <div
        className="selection"
        style={{ left: css.x, top: css.y, width: css.width, height: css.height }}
      >
        {handles &&
          HANDLES.map((h) => <div key={h} className="selection-handle" data-handle={h} />)}
      </div>
      <div className="selection-size" style={{ left: label.x, top: label.y }}>
        {text}
      </div>
    </>
  );
}
