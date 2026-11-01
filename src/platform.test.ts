import { describe, expect, it } from "vitest";
import { detectPlatform, shortcutLabel } from "./platform";

describe("detectPlatform", () => {
  it("detects macOS WKWebView", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      ),
    ).toBe("macos");
  });

  it("detects Windows WebView2", () => {
    expect(
      detectPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
      ),
    ).toBe("windows");
  });

  it("falls back to other", () => {
    expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64)")).toBe("other");
  });
});

describe("shortcutLabel", () => {
  const DEFAULT = "CommandOrControl+Shift+2";

  it("uses symbols on macOS", () => {
    expect(shortcutLabel(DEFAULT, "macos")).toBe("⌘⇧2");
    expect(shortcutLabel("Alt+Control+s", "macos")).toBe("⌥⌃S");
  });

  it("uses names elsewhere", () => {
    expect(shortcutLabel(DEFAULT, "windows")).toBe("Ctrl+Shift+2");
    expect(shortcutLabel("Super+Shift+a", "windows")).toBe("Win+Shift+A");
  });

  it("names recorded keys by what they show, not their code", () => {
    expect(shortcutLabel("CommandOrControl+Alt+ArrowUp", "macos")).toBe("⌘⌥↑");
    expect(shortcutLabel("Control+Shift+Space", "macos")).toBe("⌃⇧Space");
    expect(shortcutLabel("CommandOrControl+Alt+Minus", "windows")).toBe("Ctrl+Alt+-");
    expect(shortcutLabel("Alt+F5", "windows")).toBe("Alt+F5");
  });
});
