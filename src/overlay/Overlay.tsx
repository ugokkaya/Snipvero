import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { loadFrame } from "../frame";
import {
  frameInfo,
  onOverlayLoad,
  onSelectionCleared,
  overlayCancel,
  overlayCopy,
  overlayReady,
  overlaySave,
  overlaySelect,
  type FrameInfo,
} from "../ipc";
import { detectPlatform } from "../platform";
import { canRedo, canUndo, displayedAnnotations, selectedAnnotation } from "./annotate";
import { clientToPixel, pixelToClient, placeOutside, type Rect } from "./coords";
import {
  INITIAL_EDITOR,
  editorCursor,
  editorEnv,
  exportableRegion,
  reduceEditor,
  type EditorAction,
  type EditorEnv,
  type EditorState,
} from "./editor";
import { createExporter, type ExportAction } from "./exporting";
import { keyCommand } from "./keys";
import { measureLine } from "./measure";
import { isDragging, selectedRegion, selectionRect } from "./selection";
import { SelectionView } from "./SelectionView";
import { TextEditor } from "./TextEditor";
import { TOOLBAR_SIZE, Toolbar } from "./Toolbar";

// Konva is most of the bundle: keep it out of the main window and off the path to showing the
// frame. Each overlay preloads it once the frame is visible, before the first annotation.
const loadAnnotationLayer = () => import("./AnnotationLayer");
const AnnotationLayer = lazy(() =>
  loadAnnotationLayer().then((module) => ({ default: module.AnnotationLayer })),
);
const loadRasterizer = () => import("./rasterize");

/** For actions that do not depend on the frame (clear, cancel). */
const NO_ENV: EditorEnv = editorEnv({ width: 1, height: 1 }, { width: 1, height: 1 }, () => 0);
const TOOLBAR_GAP = 8;

const PLATFORM = detectPlatform(navigator.userAgent);
const KEYS =
  PLATFORM === "macos"
    ? { undo: "⌘Z", redo: "⇧⌘Z", copy: "⌘C or Enter", save: "⌘S" }
    : { undo: "Ctrl+Z", redo: "Ctrl+Y", copy: "Ctrl+C or Enter", save: "Ctrl+S" };

const reducer = (state: EditorState, { action, env }: { action: EditorAction; env: EditorEnv }) =>
  reduceEditor(state, action, env);

const report = (session: number, region: Rect | null) =>
  overlaySelect(session, region).catch((error: unknown) => {
    console.error("[overlay] could not record the selection", error);
  });

/**
 * Fullscreen frozen frame for one display, with region selection, annotations and
 * export. Everything but export runs in the page: no IPC while drawing. Escape cancels.
 */
export function Overlay({ index }: { index: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadedSession = useRef<number | null>(null);
  const [info, setInfo] = useState<FrameInfo | null>(null);
  const [state, dispatch] = useReducer(reducer, INITIAL_EDITOR);
  const [cursor, setCursor] = useState("crosshair");
  // The exporter guards against a second request before React re-renders; the state disables buttons.
  const [exporter] = useState(() =>
    createExporter({
      rasterize: async (plan) => (await loadRasterizer()).rasterize(plan),
      copy: overlayCopy,
      save: overlaySave,
      now: () => new Date(),
    }),
  );
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { selection, annotate } = state;

  const env = useMemo(() => info && editorEnv(info.bounds, info, measureLine), [info]);
  // The keyboard listener is installed once and reads the latest state and environment.
  const latest = useRef({ state, env });
  const exportRef = useRef<(action: ExportAction) => void>(() => undefined);
  useEffect(() => {
    latest.current = { state, env };
  });

  useEffect(() => {
    const show = async () => {
      // A window created for a capture finds the frame on start; a pre-created one is told by
      // `overlay-load`. The session check keeps both paths from loading the same frame twice.
      let frame: FrameInfo;
      try {
        frame = await frameInfo(index);
      } catch {
        return; // No capture active: a pre-created window waits for `overlay-load`.
      }
      if (loadedSession.current === frame.session) return;
      loadedSession.current = frame.session;
      try {
        const bitmap = await loadFrame(index, frame.width, frame.height);
        const canvas = canvasRef.current;
        if (!canvas) return bitmap.close();
        // Backing store at the capture's native pixel size; CSS scales it to the window.
        canvas.width = frame.width;
        canvas.height = frame.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        setInfo(frame);
        await overlayReady(frame.session);
      } catch (error) {
        // A failure after the frame is known would leave a hidden window; end this capture
        // (only this one: if it already ended, Rust ignores the request).
        console.error("[overlay] could not show the frame", error);
        void overlayCancel(frame.session);
        return;
      }
      void loadAnnotationLayer();
      void loadRasterizer();
    };
    const unlisten = onOverlayLoad(() => void show());
    // Subscribe before the initial session check: a trigger during startup must not fall
    // between checking for a frame and installing the overlay-load listener.
    void unlisten.then(show);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [index]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The text editor handles its own keys (typing, its own undo, Escape to finish); only
      // save reaches the overlay from there (see keyCommand).
      const inTextEditor = event.target instanceof HTMLTextAreaElement;
      const command = keyCommand(event, PLATFORM, inTextEditor);
      if (!command) return;
      event.preventDefault();
      if (command === "copy" || command === "save") {
        exportRef.current(command);
        return;
      }
      const { state: current, env: currentEnv } = latest.current;
      if (command === "escape") {
        // Escape first finishes a text edit (if the textarea lost focus); otherwise it cancels.
        if (current.annotate.gesture?.type === "editing") {
          dispatch({ action: { type: "commitText" }, env: currentEnv ?? NO_ENV });
          return;
        }
        const session = loadedSession.current;
        if (session === null) return;
        // Rust refuses while an export runs (the save dialog); the overlay then stays usable.
        void overlayCancel(session).then((closed) => {
          if (closed) dispatch({ action: { type: "cancel" }, env: NO_ENV });
        });
        return;
      }
      dispatch({ action: { type: command }, env: currentEnv ?? NO_ENV });
    };
    window.addEventListener("keydown", onKeyDown);
    const unlisten = onSelectionCleared((session) => {
      if (session === loadedSession.current) dispatch({ action: { type: "clear" }, env: NO_ENV });
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      void unlisten.then((fn) => fn());
    };
  }, []);

  // Rust hears about a selection only at these two moments, never while the mouse moves:
  // the first real drag of a new selection here takes it from the other displays...
  const claim = selection.phase === "creating" && selection.dragged && !selection.previous;
  useEffect(() => {
    if (claim && info) void report(info.session, null);
  }, [claim, info]);

  // ...and each finalized region is recorded for export.
  const region = selectedRegion(selection);
  useEffect(() => {
    if (region && info) void report(info.session, region);
  }, [region, info]);

  const send = (action: EditorAction) => {
    if (env) dispatch({ action, env });
  };

  /**
   * Copies or saves the region with its annotations. A text being edited is committed first, so
   * it is neither lost nor left out. On success Rust closes the overlays; after a cancelled save
   * dialog or an error the overlay stays as it was.
   */
  const exportImage = (action: ExportAction) => {
    if (!info || !env || exporter.running) return;
    let current = state;
    if (current.annotate.gesture?.type === "editing") {
      const commit = { type: "commitText" } as const;
      current = reduceEditor(current, commit, env);
      dispatch({ action: commit, env });
    }
    const region = exportableRegion(current);
    if (!region) return;
    setExporting(true);
    setNotice(null);
    void exporter
      .run(action, {
        session: info.session,
        region,
        annotations: current.annotate.history.present,
        origin: current.origin,
        measure: measureLine,
      })
      .then((result) => {
        setExporting(false);
        if (result.status === "failed") {
          console.error("[overlay] export failed:", result.message);
          setNotice(result.message);
        }
      });
  };
  useEffect(() => {
    exportRef.current = exportImage;
  });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!info || event.button !== 0) return;
    event.preventDefault(); // No text selection or native drag.
    setNotice(null);
    // Keep receiving moves when the pointer leaves the window (or the display) mid-drag.
    event.currentTarget.setPointerCapture(event.pointerId);
    send({ type: "press", point: toPixel(event, info) });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!info || !env) return;
    const point = toPixel(event, info);
    // Always dispatched: the reducers ignore it unless a drag is in progress, so a move that
    // arrives before React re-renders after the press is not lost.
    send({ type: "drag", point });
    setCursor(editorCursor(state, point, env));
  };
  const onRelease = () => send({ type: "release" });

  const rect = selectionRect(selection);
  const shown = displayedAnnotations(annotate);
  const editing = annotate.gesture?.type === "editing" ? annotate.gesture.draft : null;
  const toolbar =
    info && region
      ? {
          ...placeOutside(
            pixelToClient(region, info.bounds, info),
            TOOLBAR_SIZE,
            info.bounds,
            TOOLBAR_GAP,
            "below",
          ),
          ...TOOLBAR_SIZE,
        }
      : null;
  return (
    <div
      className="overlay"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onRelease}
      onLostPointerCapture={onRelease}
      onContextMenu={(event) => event.preventDefault()}
      onDragStart={(event) => event.preventDefault()}
    >
      <canvas ref={canvasRef} className="overlay-frame" draggable={false} />
      {info && env && rect && (shown.length > 0 || editing) && (
        <Suspense fallback={null}>
          <AnnotationLayer
            region={rect}
            origin={state.origin}
            view={info.bounds}
            frame={info}
            scale={env.scale}
            annotations={shown}
            selected={editing ? null : selectedAnnotation(annotate)}
            measure={measureLine}
          />
        </Suspense>
      )}
      {info && (
        <SelectionView
          rect={rect}
          view={info.bounds}
          frame={info}
          handles={rect !== null && !isDragging(selection)}
          toolbar={toolbar}
        />
      )}
      {info && editing && (
        <TextEditor
          key={editing.id}
          draft={editing}
          origin={state.origin}
          view={info.bounds}
          frame={info}
          measure={measureLine}
          onChange={(text) => send({ type: "type", text })}
          onCommit={() => send({ type: "commitText" })}
        />
      )}
      {toolbar && (
        <Toolbar
          position={toolbar}
          tool={annotate.tool}
          style={annotate.style}
          canUndo={canUndo(annotate)}
          canRedo={canRedo(annotate)}
          canDelete={annotate.selected !== null && annotate.gesture === null}
          canExport={!exporting}
          keys={KEYS}
          send={send}
          onExport={exportImage}
        />
      )}
      {notice ? (
        <div className="overlay-hud overlay-notice" role="alert">
          {notice}
        </div>
      ) : (
        info?.focused &&
        selection.phase === "idle" && (
          <div className="overlay-hud">Drag to select · Esc to cancel</div>
        )
      )}
    </div>
  );
}

const toPixel = (event: PointerEvent, info: FrameInfo) =>
  clientToPixel({ x: event.clientX, y: event.clientY }, info.bounds, info);
