import { useEffect, useRef } from "react";
import {
  FONT_FAMILY,
  LINE_HEIGHT,
  textSize,
  type MeasureLine,
  type TextAnnotation,
} from "./annotations";
import { pixelRatio, type Point, type Size } from "./coords";

interface Props {
  draft: TextAnnotation;
  origin: Point;
  view: Size;
  frame: Size;
  measure: MeasureLine;
  onChange: (text: string) => void;
  onCommit: () => void;
}

/**
 * A native textarea over the text being edited, so typing, IME, dead keys and Unicode (including
 * Turkish) work as in any text field. It matches the Konva text's font, size and line boxes.
 */
export function TextEditor({ draft, origin, view, frame, measure, onChange, onCommit }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Focused after mount (on pointer release), so the press can no longer move focus elsewhere.
    const textarea = ref.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const ratio = pixelRatio(view, frame);
  const fontSize = draft.fontSize / ratio.y;
  // A trailing empty line still needs room; one extra character keeps the caret inside.
  const size = textSize(`${draft.text} `, draft.fontSize, measure);
  return (
    <textarea
      ref={ref}
      className="annotation-text"
      value={draft.text}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      wrap="off"
      aria-label="Annotation text"
      style={{
        left: (origin.x + draft.at.x) / ratio.x,
        top: (origin.y + draft.at.y) / ratio.y,
        width: size.width / ratio.x + fontSize,
        height: size.height / ratio.y,
        fontSize,
        fontFamily: FONT_FAMILY,
        lineHeight: LINE_HEIGHT,
        color: draft.color,
        caretColor: draft.color,
      }}
      onChange={(event) => onChange(event.target.value)}
      onBlur={onCommit}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The first Escape ends editing and keeps the text; the next one cancels the capture.
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          onCommit();
        }
      }}
    />
  );
}
