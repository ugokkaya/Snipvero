export type Platform = "macos" | "windows" | "other";

export function detectPlatform(userAgent: string): Platform {
  if (/Mac OS X|Macintosh/.test(userAgent)) return "macos";
  if (/Windows/.test(userAgent)) return "windows";
  return "other";
}

const MAC_SYMBOLS: Record<string, string> = {
  commandorcontrol: "⌘",
  cmdorctrl: "⌘",
  command: "⌘",
  cmd: "⌘",
  super: "⌘",
  shift: "⇧",
  alt: "⌥",
  option: "⌥",
  control: "⌃",
  ctrl: "⌃",
};

const OTHER_NAMES: Record<string, string> = {
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
  control: "Ctrl",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  super: "Win",
};

/** Keys recorded by their `KeyboardEvent.code` name (src/shortcut.ts) that read better as a symbol. */
const KEY_NAMES: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "Page Up",
  pagedown: "Page Down",
  minus: "-",
  equal: "=",
  comma: ",",
  period: ".",
  slash: "/",
  backslash: "\\",
  semicolon: ";",
  quote: "'",
  backquote: "`",
  bracketleft: "[",
  bracketright: "]",
};

const keyName = (part: string) => KEY_NAMES[part.toLowerCase()] ?? part.toUpperCase();

/** Human-readable label for a Tauri accelerator such as "CommandOrControl+Shift+2". */
export function shortcutLabel(accelerator: string, platform: Platform): string {
  const parts = accelerator.split("+").map((part) => part.trim());
  if (platform === "macos") {
    return parts.map((part) => MAC_SYMBOLS[part.toLowerCase()] ?? keyName(part)).join("");
  }
  return parts.map((part) => OTHER_NAMES[part.toLowerCase()] ?? keyName(part)).join("+");
}
