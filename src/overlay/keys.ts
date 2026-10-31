import type { Platform } from "../platform";

export type KeyCommand = "escape" | "undo" | "redo" | "delete" | "copy" | "save";

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** Held down: auto-repeat must not start a second export. */
  repeat?: boolean;
  /** Part of an IME composition, which owns Enter and Escape. */
  isComposing?: boolean;
}

/**
 * Overlay keyboard commands. Cmd on macOS, Ctrl on Windows: Z undoes, Shift+Z redoes (Ctrl+Y also
 * on Windows), C or Enter copies the screenshot, S saves it.
 *
 * In the text editor the textarea keeps its own keys (typing, Enter for a new line, its own undo,
 * Cmd/Ctrl+C to copy text, Escape to finish editing). Only save passes through, so the overlay can
 * commit the text first instead of the shortcut doing nothing or dropping it.
 */
export function keyCommand(
  event: KeyLike,
  platform: Platform,
  inTextEditor = false,
): KeyCommand | null {
  if (event.isComposing) return null;
  const mod = platform === "macos" ? event.metaKey : event.ctrlKey;
  const key = event.key.toLowerCase();
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
  const exportKey = (command: KeyCommand) => (event.repeat ? null : command);
  if (inTextEditor) {
    return mod && !event.altKey && !event.shiftKey && key === "s" ? exportKey("save") : null;
  }
  if (event.key === "Escape") return "escape";
  if (mod && !event.altKey) {
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && platform !== "macos" && !event.shiftKey) return "redo";
    if (event.shiftKey) return null;
    if (key === "c") return exportKey("copy");
    if (key === "s") return exportKey("save");
    return null;
  }
  if (plain) {
    if (event.key === "Delete" || event.key === "Backspace") return "delete";
    if (event.key === "Enter" && !event.shiftKey) return exportKey("copy");
  }
  return null;
}
