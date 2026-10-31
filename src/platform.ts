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

/** Human-readable label for a Tauri accelerator such as "CommandOrControl+Shift+2". */
export function shortcutLabel(accelerator: string, platform: Platform): string {
  const parts = accelerator.split("+").map((part) => part.trim());
  if (platform === "macos") {
    return parts.map((part) => MAC_SYMBOLS[part.toLowerCase()] ?? part.toUpperCase()).join("");
  }
  return parts.map((part) => OTHER_NAMES[part.toLowerCase()] ?? part.toUpperCase()).join("+");
}
