// Recording a new capture shortcut in the main window (ADR-030). Rust validates and registers it;
// this only turns a key press into an accelerator and words Rust's answer.
import { t } from "./i18n";
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
  const example = t(
    platform === "macos" ? "app.shortcut.example.macos" : "app.shortcut.example.other",
  );
  switch (rejection) {
    case "modifiers":
      return (
        t("app.shortcut.rejection.modifiers", { example }) +
        (platform === "macos" ? t("app.shortcut.rejection.modifiersF13") : "")
      );
    case "reserved":
      return t("app.shortcut.rejection.reserved");
    case "unavailable":
      return t("app.shortcut.rejection.unavailable");
    case "notSaved":
      return t("app.shortcut.rejection.notSaved");
    case "notAllowed":
    case "invalid":
      return t("app.shortcut.rejection.invalid");
  }
}
