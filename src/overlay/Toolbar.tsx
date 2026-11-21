import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { COLORS, type SizeLevel, type Style, type Tool } from "./annotations";
import { placeOutside, type Point, type Size } from "./coords";
import type { EditorAction } from "./editor";
import { t, useLanguage, type MessageKey } from "../i18n";

// Layout constants, mirrored by the `.toolbar` CSS, so the toolbar is placed without measuring it.
const BUTTON = 28;
const GAP = 2;
const PADDING = 4;
const SEPARATOR = 7;
const BUTTONS = 7 + COLORS.length + 3 + 3 + 4;
const SEPARATORS = 4;
/** The labelled Record button of the record-only toolbar (the `.toolbar-record` CSS width). */
const RECORD_BUTTON = 88;

export const TOOLBAR_SIZE: Size = {
  width: 2 * PADDING + BUTTONS * BUTTON + SEPARATORS * SEPARATOR + (BUTTONS + SEPARATORS - 1) * GAP,
  height: 2 * PADDING + BUTTON,
};

/** Opened to choose a region to record: only the Record button is offered. */
export const RECORD_TOOLBAR_SIZE: Size = {
  width: 2 * PADDING + RECORD_BUTTON,
  height: TOOLBAR_SIZE.height,
};

export const toolbarSize = (mode: "capture" | "record"): Size =>
  mode === "record" ? RECORD_TOOLBAR_SIZE : TOOLBAR_SIZE;

const icon = (path: ReactNode) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    {path}
  </svg>
);

const TOOLS: readonly { tool: Tool; label: MessageKey; icon: ReactNode }[] = [
  {
    tool: "select",
    label: "overlay.tool.select",
    icon: icon(<path d="M4 2.5v10l2.8-2.6 1.9 4.1 1.6-.7-1.9-4.1H12z" fill="currentColor" />),
  },
  {
    tool: "arrow",
    label: "overlay.tool.arrow",
    icon: icon(<path d="M3 13 12.5 3.5M7 3.5h5.5V9" />),
  },
  {
    tool: "rect",
    label: "overlay.tool.rect",
    icon: icon(<rect x="2.5" y="3.5" width="11" height="9" />),
  },
  {
    tool: "text",
    label: "overlay.tool.text",
    icon: icon(<path d="M3 3.5h10M8 3.5v10M6 13.5h4" />),
  },
  {
    tool: "fill",
    label: "overlay.tool.fill",
    icon: icon(<rect x="2.5" y="3.5" width="11" height="9" fill="currentColor" />),
  },
  {
    tool: "blur",
    label: "overlay.tool.blur",
    icon: icon(
      <>
        <rect x="2.5" y="2.5" width="11" height="11" />
        <path d="M2.5 8h11M8 2.5v11M5.25 2.5v5.5M10.75 8v5.5" />
      </>,
    ),
  },
  {
    tool: "highlight",
    label: "overlay.tool.highlight",
    icon: icon(<path d="M9.5 2.5l4 4-5.5 5.5H5.5V9.5zM5.5 12l-2 1.5h5" />),
  },
];

const SIZE_LABELS = ["overlay.size.small", "overlay.size.medium", "overlay.size.large"] as const;

const RECORD_ICON = icon(
  <>
    <circle cx="8" cy="8" r="5.5" />
    <circle cx="8" cy="8" r="2.3" fill="currentColor" />
  </>,
);

interface Props {
  position: Point;
  mode: "capture" | "record";
  tool: Tool;
  style: Style;
  /** Which style buttons act on the current tool or selection; the others are dimmed. */
  controls: { color: boolean; size: boolean };
  canUndo: boolean;
  canRedo: boolean;
  canDelete: boolean;
  /** False while an export runs, so it cannot be started twice. */
  canExport: boolean;
  /** Shortcut labels for tooltips, per platform. */
  keys: { undo: string; redo: string; copy: string; save: string };
  send: (action: EditorAction) => void;
  onExport: (action: "copy" | "save") => void;
  onCaptureDelayed: () => void;
  /** Starts recording the selected region as video. */
  onRecord: () => void;
}

function ToolbarTooltip({ id, anchor, label }: { id: string; anchor: HTMLElement; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const place = () => {
      const element = ref.current;
      if (!element) return;
      const position = placeOutside(
        anchor.getBoundingClientRect(),
        element.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        8,
        "above",
      );
      element.style.left = `${position.x}px`;
      element.style.top = `${position.y}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, label]);
  return (
    <div ref={ref} id={id} role="tooltip" className="toolbar-tooltip">
      {label}
    </div>
  );
}

/** Floating annotation toolbar next to the selection (FR-4). */
export function Toolbar(props: Props) {
  useLanguage();
  const tooltipId = useId();
  const [tooltip, setTooltip] = useState<{
    key: string;
    label: string;
    anchor: HTMLElement;
  } | null>(null);
  const {
    position,
    mode,
    tool,
    style,
    controls,
    canUndo,
    canRedo,
    canDelete,
    canExport,
    keys,
    send,
    onExport,
  } = props;
  const size = toolbarSize(mode);
  const button = (
    key: string,
    label: string,
    content: ReactNode,
    onClick: () => void,
    options: { pressed?: boolean; disabled?: boolean; className?: string } = {},
  ) => (
    <span
      key={key}
      className="toolbar-button-anchor"
      onPointerEnter={(event) => setTooltip({ key, label, anchor: event.currentTarget })}
      onPointerLeave={() => setTooltip(null)}
      onFocus={(event) => setTooltip({ key, label, anchor: event.currentTarget })}
      onBlur={() => setTooltip(null)}
    >
      <button
        type="button"
        className={options.className ?? "toolbar-button"}
        aria-label={label}
        aria-describedby={tooltip?.key === key ? tooltipId : undefined}
        tabIndex={-1}
        disabled={options.disabled}
        {...(options.pressed !== undefined && { "aria-pressed": options.pressed })}
        onClick={onClick}
      >
        {content}
      </button>
    </span>
  );
  const recordButton = button(
    "record",
    t(mode === "record" ? "overlay.record.label" : "overlay.record.tooltip"),
    mode === "record" ? (
      <>
        {RECORD_ICON}
        <span>{t("overlay.record.button")}</span>
      </>
    ) : (
      RECORD_ICON
    ),
    props.onRecord,
    { disabled: !canExport, ...(mode === "record" && { className: "toolbar-record" }) },
  );
  return (
    <>
      <div
        className="toolbar"
        role="toolbar"
        style={{
          left: position.x,
          top: position.y,
          width: size.width,
          height: size.height,
        }}
        // The overlay must not start a selection, and a text being edited must keep focus.
        onPointerDown={(event) => {
          setTooltip(null);
          event.stopPropagation();
        }}
        onClick={() => setTooltip(null)}
        onMouseDown={(event) => event.preventDefault()}
      >
        {mode === "record" ? (
          recordButton
        ) : (
          <>
            {TOOLS.map((entry) =>
              button(
                entry.tool,
                t(entry.label),
                entry.icon,
                // Clicking the active drawing tool again returns to select, so no extra click is needed.
                () => send({ type: "setTool", tool: entry.tool === tool ? "select" : entry.tool }),
                { pressed: entry.tool === tool },
              ),
            )}
            <span className="toolbar-separator" />
            {COLORS.map((color) =>
              button(
                color,
                t("overlay.color", { color }),
                <span className="toolbar-swatch" style={{ background: color }} />,
                () => send({ type: "setColor", color }),
                { pressed: color === style.color, disabled: !controls.color },
              ),
            )}
            <span className="toolbar-separator" />
            {([0, 1, 2] as const satisfies readonly SizeLevel[]).map((size) =>
              button(
                `size-${size}`,
                t(SIZE_LABELS[size]),
                <span
                  className="toolbar-size"
                  style={{ width: 4 + size * 4, height: 4 + size * 4 }}
                />,
                () => send({ type: "setSize", size }),
                { pressed: size === style.size, disabled: !controls.size },
              ),
            )}
            <span className="toolbar-separator" />
            {button(
              "undo",
              t("overlay.undo", { key: keys.undo }),
              icon(<path d="M5.5 3 2.5 6l3 3M2.5 6h7a4 4 0 0 1 0 8H7" />),
              () => send({ type: "undo" }),
              { disabled: !canUndo },
            )}
            {button(
              "redo",
              t("overlay.redo", { key: keys.redo }),
              icon(<path d="M10.5 3l3 3-3 3M13.5 6h-7a4 4 0 0 0 0 8H9" />),
              () => send({ type: "redo" }),
              { disabled: !canRedo },
            )}
            {button(
              "delete",
              t("overlay.delete"),
              icon(<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9" />),
              () => send({ type: "delete" }),
              { disabled: !canDelete },
            )}
            <span className="toolbar-separator" />
            {button(
              "delayed",
              t("overlay.delayed"),
              icon(
                <>
                  <circle cx="8" cy="9" r="5.5" />
                  <path d="M8 5.5V9l2 1.5M6 1h4M8 1v2" />
                </>,
              ),
              props.onCaptureDelayed,
              { disabled: !canExport },
            )}
            {button(
              "copy",
              t("overlay.copy", { key: keys.copy }),
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
              t("overlay.save", { key: keys.save }),
              icon(<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" />),
              () => onExport("save"),
              { disabled: !canExport },
            )}
            {recordButton}
          </>
        )}
      </div>
      {tooltip && <ToolbarTooltip id={tooltipId} anchor={tooltip.anchor} label={tooltip.label} />}
    </>
  );
}
