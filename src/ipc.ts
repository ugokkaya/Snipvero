// Typed wrappers around Tauri commands and events.
// Event names must match `src-tauri/src/events.rs`; commands are registered in `src-tauri/src/lib.rs`.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Rect } from "./overlay/coords";

export const CAPTURE_FAILED = "capture-failed";
export const OVERLAY_LOAD = "overlay-load";
export const OVERLAY_SELECTION_CLEARED = "overlay-selection-cleared";
export const OVERLAY_LABEL_PREFIX = "overlay-";
export const ABOUT_LABEL = "about";

export interface LogicalRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FrameInfo {
  session: number;
  index: number;
  displayId: number;
  bounds: LogicalRect;
  scale: number;
  width: number;
  height: number;
  focused: boolean;
}

export interface ShortcutStatus {
  accelerator: string;
  registered: boolean;
  error: string | null;
}

export interface AppStatus {
  captureSupported: boolean;
  screenRecordingAllowed: boolean;
  shortcut: ShortcutStatus | null;
}

export function onCaptureFailed(handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>(CAPTURE_FAILED, (event) => handler(event.payload));
}

/** Sent to this pre-created overlay window when a capture starts. */
export function onOverlayLoad(handler: (session: number) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<number>(OVERLAY_LOAD, (event) => handler(event.payload));
}

/** Another display took the selection of this capture session. */
export function onSelectionCleared(handler: (session: number) => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen<number>(OVERLAY_SELECTION_CLEARED, (event) =>
    handler(event.payload),
  );
}

export const frameInfo = (index: number) => invoke<FrameInfo>("overlay_frame_info", { index });

/** Raw RGBA pixels (ADR-007). */
export const frameRgba = (index: number) => invoke<ArrayBuffer>("overlay_frame", { index });

export const overlayReady = (session: number) => invoke("overlay_ready", { session });

/**
 * Frame-local physical pixels (`PixelRect` in Rust). Call on press with `null` to take the
 * selection from other displays, then with each finalized region; never while the mouse moves.
 */
export const overlaySelect = (session: number, region: Rect | null) =>
  invoke("overlay_select", { session, region });

/**
 * Ends capture `session` (Escape). Resolves false when that capture already ended or an export
 * (the save dialog) is running; a stale page can never close a newer capture.
 */
export const overlayCancel = (session: number) => invoke<boolean>("overlay_cancel", { session });

/** Export metadata travels in headers so the body can stay raw bytes (`src-tauri/src/export`). */
export const EXPORT_SESSION_HEADER = "x-snipvero-session";
export const EXPORT_REGION_HEADER = "x-snipvero-region";
export const EXPORT_FILE_NAME_HEADER = "x-snipvero-file-name";

/** `done`: copied or saved, and Rust closes the overlays. `cancelled`: the save dialog was dismissed. */
export type ExportOutcome = "done" | "cancelled";

const exportHeaders = (session: number, region: Rect) => ({
  [EXPORT_SESSION_HEADER]: String(session),
  [EXPORT_REGION_HEADER]: `${region.x},${region.y},${region.width},${region.height}`,
});

/**
 * Copies `region` (frame pixels) with the annotation layer blended over it. `layer` is raw RGBA of
 * the region's size, or empty without annotations; the screenshot itself never leaves Rust.
 */
export const overlayCopy = (session: number, region: Rect, layer: Uint8Array) =>
  invoke<ExportOutcome>("overlay_copy", layer, { headers: exportHeaders(session, region) });

/** Like `overlayCopy`, but asks for a file name (suggesting `fileName`) and saves a PNG. */
export const overlaySave = (session: number, region: Rect, layer: Uint8Array, fileName: string) =>
  invoke<ExportOutcome>("overlay_save", layer, {
    headers: { ...exportHeaders(session, region), [EXPORT_FILE_NAME_HEADER]: fileName },
  });

export const appStatus = () => invoke<AppStatus>("app_status");

/** App metadata from Rust (`src-tauri/src/about.rs`); the page never repeats it. */
export interface AppInfo {
  name: string;
  version: string;
  copyright: string;
  repository: string;
  contributors: string;
}

export const appInfo = () => invoke<AppInfo>("app_info");

/** Same capture as the tray and the global shortcut. */
export const startCapture = () => invoke("start_capture");

/** Opens the About window, or brings it to the front. */
export const showAbout = () => invoke("show_about");

/** The fixed destinations Rust can open; the page never passes an address (ADR-024). */
export type Link = "repository" | "contributors" | "license";

export const openLink = (link: Link) => invoke("open_link", { link });

export const openScreenRecordingSettings = () => invoke("open_screen_recording_settings");

export const restartApp = () => invoke("restart_app");
