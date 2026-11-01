// Recording a new capture shortcut in the main window (ADR-030). Rust validates and registers it;
// this only turns a key press into an accelerator and words Rust's answer.
import type { ShortcutRejection } from "./ipc";
import type { Platform } from "./platform";

/** Mirrors `shortcut::DEFAULT_ACCELERATOR` in Rust. */
export const DEFAULT_ACCELERATOR = "CommandOrControl+Shift+2";

export interface KeyPress {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

const MODIFIER_CODE = /^(Meta|OS|Control|Alt|Shift)(Left|Right)?$|^(CapsLock|Fn|FnLock)$/;

/** `Digit2` → `2`, `KeyA` → `A`; other codes (`F5`, `Space`, `ArrowUp`) are already accelerator names. */
function keyToken(code: string): string {
  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter?.[1]) return letter[1];
  return code;
}

/**
 * The accelerator for a key press, or `null` while only modifiers are held. Uses the physical key
 * (`code`), not the character: on a Turkish layout Shift+2 types `'`, and Option changes most
 * characters on macOS, but the global shortcut is registered by key position too. The primary
 * modifier (⌘ on macOS, Ctrl on Windows) is written as `CommandOrControl`, like the default.
 */
export function acceleratorFromKey(press: KeyPress, platform: Platform): string | null {
  if (press.isComposing || press.code === "" || MODIFIER_CODE.test(press.code)) return null;
  const mac = platform === "macos";
  const parts: string[] = [];
  if (mac ? press.metaKey : press.ctrlKey) parts.push("CommandOrControl");
  if (mac && press.ctrlKey) parts.push("Control");
  if (press.altKey) parts.push("Alt");
  if (press.shiftKey) parts.push("Shift");
  if (!mac && press.metaKey) parts.push("Super");
  parts.push(keyToken(press.code));
  return parts.join("+");
}

/** Escape alone ends recording without a change. */
export const isCancel = (press: KeyPress) =>
  press.code === "Escape" && !press.metaKey && !press.ctrlKey && !press.altKey && !press.shiftKey;

export function rejectionMessage(rejection: ShortcutRejection, platform: Platform): string {
  const example = platform === "macos" ? "⌘⇧ or ⌃⌥" : "Ctrl+Shift or Ctrl+Alt";
  switch (rejection) {
    case "modifiers":
      return `Use two modifier keys, such as ${example}, so other apps keep their own shortcuts. With a function key (F1–F24), one is enough.`;
    case "reserved":
      return "The system or most apps use that combination. Choose another one.";
    case "unavailable":
      return "That combination could not be registered, probably because another app uses it.";
    case "notSaved":
      return "The shortcut could not be saved. The previous shortcut still works.";
    case "notAllowed":
    case "invalid":
      return "That key cannot be used in a shortcut. Choose another one.";
  }
}
