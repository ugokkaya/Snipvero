import type { ReactNode } from "react";
import { COLORS, type SizeLevel, type Style, type Tool } from "./annotations";
import type { Point, Size } from "./coords";
import type { EditorAction } from "./editor";

// Layout constants, mirrored by the `.toolbar` CSS, so the toolbar is placed without measuring it.
const BUTTON = 28;
const GAP = 2;
const PADDING = 4;
const SEPARATOR = 7;
const BUTTONS = 4 + COLORS.length + 3 + 3 + 2;
const SEPARATORS = 4;

export const TOOLBAR_SIZE: Size = {
  width: 2 * PADDING + BUTTONS * BUTTON + SEPARATORS * SEPARATOR + (BUTTONS + SEPARATORS - 1) * GAP,
  height: 2 * PADDING + BUTTON,
};

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    {path}
  </svg>
);

const TOOLS: readonly { tool: Tool; label: string; icon: ReactNode }[] = [
  {
    tool: "select",
    label: "Select and move",
    icon: icon(<path d="M4 2.5v10l2.8-2.6 1.9 4.1 1.6-.7-1.9-4.1H12z" fill="currentColor" />),
  },
  { tool: "arrow", label: "Arrow", icon: icon(<path d="M3 13 12.5 3.5M7 3.5h5.5V9" />) },
  { tool: "rect", label: "Rectangle", icon: icon(<rect x="2.5" y="3.5" width="11" height="9" />) },
  { tool: "text", label: "Text", icon: icon(<path d="M3 3.5h10M8 3.5v10M6 13.5h4" />) },
];

const SIZE_LABELS = ["Small", "Medium", "Large"] as const;

interface Props {
  position: Point;
  tool: Tool;
  style: Style;
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  /** False while an export runs, so it cannot be started twice. */
  canExport: boolean;
  /** Shortcut labels for tooltips, per platform. */
  keys: { undo: string; redo: string; copy: string; save: string };
  send: (action: EditorAction) => void;
  onExport: (action: "copy" | "save") => void;
}

/** Floating annotation toolbar next to the selection (FR-4). */
export function Toolbar(props: Props) {
  const { position, tool, style, canUndo, canRedo, canDelete, canExport, keys, send, onExport } =
    props;
  const button = (
    key: string,
    label: string,
    content: ReactNode,
    onClick: () => void,
    options: { pressed?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      key={key}
      type="button"
      className="toolbar-button"
      title={label}
      aria-label={label}
      tabIndex={-1}
      disabled={options.disabled}
      {...(options.pressed !== undefined && { "aria-pressed": options.pressed })}
      onClick={onClick}
    >
      {content}
    </button>
  );
  return (
    <div
      className="toolbar"
      role="toolbar"
      style={{
        left: position.x,
        top: position.y,
        width: TOOLBAR_SIZE.width,
        height: TOOLBAR_SIZE.height,
      }}
      // The overlay must not start a selection, and a text being edited must keep focus.
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.preventDefault()}
    >
      {TOOLS.map((t) =>
        button(
          t.tool,
          t.label,
          t.icon,
          // Clicking the active drawing tool again returns to select, so no extra click is needed.
          () => send({ type: "setTool", tool: t.tool === tool ? "select" : t.tool }),
          { pressed: t.tool === tool },
        ),
      )}
      <span className="toolbar-separator" />
      {COLORS.map((color) =>
        button(
          color,
          `Color ${color}`,
          <span className="toolbar-swatch" style={{ background: color }} />,
          () => send({ type: "setColor", color }),
          { pressed: color === style.color },
        ),
      )}
      <span className="toolbar-separator" />
      {([0, 1, 2] as const satisfies readonly SizeLevel[]).map((size) =>
        button(
          `size-${size}`,
          `${SIZE_LABELS[size]} stroke and text`,
          <span className="toolbar-size" style={{ width: 4 + size * 4, height: 4 + size * 4 }} />,
          () => send({ type: "setSize", size }),
          { pressed: size === style.size },
        ),
      )}
      <span className="toolbar-separator" />
      {button(
        "undo",
        `Undo (${keys.undo})`,
        icon(<path d="M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7" />),
        () => send({ type: "undo" }),
        { disabled: !canUndo },
      )}
      {button(
        "redo",
        `Redo (${keys.redo})`,
        icon(<path d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8H9" />),
        () => send({ type: "redo" }),
        { disabled: !canRedo },
      )}
      {button(
        "delete",
        "Delete selected annotation (Delete)",
        icon(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />),
        () => send({ type: "delete" }),
        { disabled: !canDelete },
      )}
      <span className="toolbar-separator" />
      {button(
        "copy",
        `Copy to clipboard (${keys.copy})`,
        icon(
          <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
            <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
          </>,
        ),
        () => onExport("copy"),
        { disabled: !canExport },
      )}
      {button(
        "save",
        `Save as PNG (${keys.save})`,
        icon(<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />),
        () => onExport("save"),
        { disabled: !canExport },
      )}
    </div>
  );
}
