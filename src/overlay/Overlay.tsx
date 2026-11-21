import {
  Suspense,
  lazy,
  useCallback,
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
  overlayCaptureDelayed,
  overlayCopy,
  overlayReady,
  overlaySave,
  overlaySelect,
  MICROPHONE_UNAVAILABLE,
  recordingStart,
  type FrameInfo,
} from "../ipc";
import { detectPlatform } from "../platform";
import { t, useLanguage } from "../i18n";
import { canRedo, canUndo, displayedAnnotations, selectedAnnotation } from "./annotate";
import { styleControls } from "./annotations";
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
import { Toolbar, toolbarSize } from "./Toolbar";

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
const keys = () =>
  PLATFORM === "macos"
    ? { undo: "⌘Z", redo: "⇧⌘Z", copy: t("overlay.keys.copy", { key: "⌘C" }), save: "⌘S" }
    : {
        undo: "Ctrl+Z",
        redo: "Ctrl+Y",
        copy: t("overlay.keys.copy", { key: "Ctrl+C" }),
        save: "Ctrl+S",
      };

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
  useLanguage();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The frame canvas holds the native-resolution capture that mosaics are cut from. State, so the
  // annotation layer renders again once it exists.
  const [frameCanvas, setFrameCanvas] = useState<HTMLCanvasElement | null>(null);
  const frameRef = useCallback((element: HTMLCanvasElement | null) => {
    canvasRef.current = element;
    setFrameCanvas(element);
  }, []);
  const loadedSession = useRef<number | null>(null);
  const [info, setInfo] = useState<FrameInfo | null>(null);
  const [state, dispatch] = useReducer(reducer, INITIAL_EDITOR);
  const [cursor, setCursor] = useState("crosshair");
  // The exporter guards against a second request before React re-renders; the state disables buttons.
  const [exporter] = useState(() =>
    createExporter({
      rasterize: async (plan, source) => (await loadRasterizer()).rasterize(plan, source),
      copy: overlayCopy,
      save: overlaySave,
      now: () => new Date(),
    }),
  );
  const [exporting, setExporting] = useState(false);
  const delaying = useRef(false);
  const [notice, setNotice] = useState<string | null>(null);
  // The microphone is switched on but the system does not allow it: offer to go on without it.
  const [microphoneOffer, setMicrophoneOffer] = useState(false);
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
        dispatch({ action: { type: "loadFrame", region: frame.region }, env: NO_ENV });
        delaying.current = false;
        setExporting(false);
        setNotice(null);
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
    if (!info || !env || exporter.running || delaying.current || info.mode === "record") return;
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
        source: canvasRef.current,
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

  const captureDelayed = () => {
    if (!info || !region || exporter.running || delaying.current) return;
    delaying.current = true;
    setExporting(true);
    setNotice(null);
    void overlayCaptureDelayed(info.session, region).catch((error: unknown) => {
      delaying.current = false;
      setExporting(false);
      setNotice(String(error));
    });
  };

  /**
   * Records the selected region. Annotations are not part of a video. On success Rust closes the
   * overlays before the first frame, so there is nothing more to do here.
   */
  const record = (withoutMicrophone = false) => {
    if (!info || !region || exporter.running || delaying.current) return;
    delaying.current = true;
    setExporting(true);
    setNotice(null);
    setMicrophoneOffer(false);
    void recordingStart(info.session, region, withoutMicrophone).catch((error: unknown) => {
      delaying.current = false;
      setExporting(false);
      // A microphone that is switched on but not allowed is never dropped silently: the choice is
      // the user's, here, with the selection still on screen.
      if (error === MICROPHONE_UNAVAILABLE) {
        setMicrophoneOffer(true);
        setNotice(t("overlay.microphoneNotice"));
      } else {
        setNotice(String(error));
      }
    });
  };

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
  // A selected annotation decides which style buttons act (a tool only draws the next one).
  const selectedKind = selectedAnnotation(annotate)?.kind ?? null;
  const size = info && toolbarSize(info.mode);
  const toolbar =
    info && region && size
      ? {
          ...placeOutside(
            pixelToClient(region, info.bounds, info),
            size,
            info.bounds,
            TOOLBAR_GAP,
            "below",
          ),
          ...size,
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
      <canvas ref={frameRef} className="overlay-frame" draggable={false} />
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
            source={frameCanvas}
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
      {toolbar && info && (
        <Toolbar
          position={toolbar}
          mode={info.mode}
          tool={annotate.tool}
          style={annotate.style}
          controls={styleControls(selectedKind ?? annotate.tool)}
          canUndo={canUndo(annotate)}
          canRedo={canRedo(annotate)}
          canDelete={annotate.selected !== null && annotate.gesture === null}
          canExport={!exporting}
          keys={keys()}
          send={send}
          onExport={exportImage}
          onCaptureDelayed={captureDelayed}
          onRecord={() => record()}
        />
      )}
      {notice ? (
        <div className="overlay-hud overlay-notice" role="alert">
          {notice}
          {microphoneOffer && (
            <button type="button" className="overlay-offer" onClick={() => record(true)}>
              {t("overlay.recordWithoutMicrophone")}
            </button>
          )}
        </div>
      ) : (
        info?.focused &&
        selection.phase === "idle" && (
          <div className="overlay-hud">
            {t(info.mode === "record" ? "overlay.hint.record" : "overlay.hint.capture")}
          </div>
        )
      )}
    </div>
  );
}

const toPixel = (event: PointerEvent, info: FrameInfo) =>
  clientToPixel({ x: event.clientX, y: event.clientY }, info.bounds, info);
