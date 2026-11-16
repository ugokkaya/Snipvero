// Typed wrappers around Tauri commands and events.
// Event names must match `src-tauri/src/events.rs`; commands are registered in `src-tauri/src/lib.rs`.
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Rect } from "./overlay/coords";

export const CAPTURE_FAILED = "capture-failed";
export const OVERLAY_LOAD = "overlay-load";
export const OVERLAY_SELECTION_CLEARED = "overlay-selection-cleared";
export const OVERLAY_LABEL_PREFIX = "overlay-";
export const ABOUT_LABEL = "about";
export const UPDATE_CHECK_REQUESTED = "update-check-requested";
export const RECORDING_STATE = "recording-state";
export const RECORDING_FAILED = "recording-failed";
export const RECORDING_LABEL = "recording";
/** URI scheme of the review window's video; Rust serves only the finished recording (ADR-037). */
export const RECORDING_PROTOCOL = "snipvero-recording";

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
  region: Rect | null;
  /** `record`: the overlay only chooses a region to record. */
  mode: "capture" | "record";
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

/** Hide the overlays, then read fresh pixels of the same region after five seconds. */
export const overlayCaptureDelayed = (session: number, region: Rect) =>
  invoke("overlay_capture_delayed", { session, region });

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

/** Why Rust did not take a new shortcut (`shortcut::Rejection`); the previous one stays. */
export const SHORTCUT_REJECTIONS = [
  "invalid",
  "modifiers",
  "reserved",
  "unavailable",
  "notSaved",
  "notAllowed",
] as const;
export type ShortcutRejection = (typeof SHORTCUT_REJECTIONS)[number];

/** A rejected shortcut command's reason; anything unexpected counts as `invalid`. */
export function shortcutRejection(error: unknown): ShortcutRejection {
  return SHORTCUT_REJECTIONS.find((rejection) => rejection === error) ?? "invalid";
}

/** Registers and saves a new capture shortcut; `null` restores the default. Main window only. */
export const setShortcut = (accelerator: string | null) =>
  invoke<ShortcutStatus>("shortcut_set", { accelerator });

/** Releases the capture shortcut while a new one is recorded (`true`), or registers it again. */
export const suspendShortcut = (suspended: boolean) =>
  invoke<ShortcutStatus | null>("shortcut_suspend", { suspended });

/** App metadata from Rust (`src-tauri/src/about.rs`); the page never repeats it. */
export interface AppInfo {
  name: string;
  version: string;
  copyright: string;
  website: string;
  supportEmail: string;
  repository: string;
  contributors: string;
}

export const appInfo = () => invoke<AppInfo>("app_info");

/** Same capture as the tray and the global shortcut. */
export const startCapture = () => invoke("start_capture");

/** Opens the About window, or brings it to the front. */
export const showAbout = () => invoke("show_about");

/** The fixed destinations Rust can open; the page never passes an address (ADR-024). */
export type Link = "website" | "support" | "repository" | "contributors" | "license";

export const openLink = (link: Link) => invoke("open_link", { link });

export const openScreenRecordingSettings = () => invoke("open_screen_recording_settings");

export const restartApp = () => invoke("restart_app");

/**
 * Why an update check or install did not succeed (`update::Failure` in Rust). The running
 * version is never touched by a failure.
 */
export const UPDATE_FAILURES = [
  "unavailable",
  "network",
  "manifest",
  "noBuild",
  "verification",
  "location",
  "busy",
  "install",
  "cancelled",
  "inProgress",
  "failed",
] as const;
export type UpdateFailure = (typeof UPDATE_FAILURES)[number];

/** A rejected update command's reason; anything unexpected counts as `failed`. */
export function updateFailure(error: unknown): UpdateFailure {
  return UPDATE_FAILURES.find((failure) => failure === error) ?? "failed";
}

export interface UpdateCheck {
  current: string;
  available: { version: string; notes: string } | null;
}

export type UpdateProgress =
  | { event: "started"; data: { contentLength: number | null } }
  | { event: "downloaded"; data: { bytes: number } }
  | { event: "installing" }
  | { event: "restarting" };

/**
 * Asks the fixed update endpoint (Rust, `tauri.conf.json`) for a newer version. The only network
 * request of the app, and only when the user asks; the page passes no address (ADR-028). Accepted
 * from the main and About windows only.
 */
export const checkForUpdate = () => invoke<UpdateCheck>("update_check");

/** Downloads, verifies and installs the update the last check found, then restarts the app. */
export function installUpdate(onProgress: (progress: UpdateProgress) => void) {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invoke("update_install", { onProgress: channel });
}

/** The menu bar's Check for Updates… (sent to the main window only). */
export function onUpdateCheckRequested(handler: () => void): Promise<UnlistenFn> {
  return getCurrentWebviewWindow().listen(UPDATE_CHECK_REQUESTED, () => handler());
}

/** Stops a running download; nothing has been installed at that point. */
export const cancelUpdate = () => invoke("update_cancel");

/** Where a recording is (`recording::Phase` in Rust). */
export type RecordingPhase = "idle" | "starting" | "recording" | "stopping" | "finished";

/** `recording::RecordingStatus`, sent on every state change, never per frame. */
export interface RecordingStatus {
  supported: boolean;
  phase: RecordingPhase;
  /** Opaque id of the current recording; null while idle. The page never gets a path. */
  id: number | null;
  elapsedMs: number;
  capMs: number;
  width: number;
  height: number;
  bytes: number;
  durationMs: number | null;
  /** Why the recording ended other than by the user (the maximum length, an encoder error). */
  notice: string | null;
}

/**
 * Records `region` (frame pixels) of the display this overlay shows. On success Rust closes the
 * overlays first, so the selection is never in the video; the tray then stops the recording.
 */
export const recordingStart = (session: number, region: Rect) =>
  invoke<RecordingStatus>("recording_start", { session, region });

export const recordingStatus = () => invoke<RecordingStatus>("recording_status");

/** Same as the tray row: start choosing a region, stop the running recording, or review the last. */
export const startRecording = () => invoke("start_recording");

/** Deletes the finished recording and closes its window. */
export const recordingDiscard = (id: number) => invoke("recording_discard", { id });

/** Asks where to save the MP4; on `done` the temporary file is gone. */
export const recordingSave = (id: number, fileName: string) =>
  invoke<ExportOutcome>("recording_save", { id, fileName });

/** The file itself (to paste in Finder) or its path, valid until the recording is deleted. */
export const recordingCopy = (id: number, kind: "file" | "path") =>
  invoke("recording_copy", { id, kind });

/** The video element's source for a finished recording. */
export const recordingSource = (id: number) => convertFileSrc(String(id), RECORDING_PROTOCOL);

export function onRecordingState(handler: (status: RecordingStatus) => void): Promise<UnlistenFn> {
  return listen<RecordingStatus>(RECORDING_STATE, (event) => handler(event.payload));
}

export function onRecordingFailed(handler: (message: string) => void): Promise<UnlistenFn> {
  return listen<string>(RECORDING_FAILED, (event) => handler(event.payload));
}
