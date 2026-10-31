import { describe, expect, it } from "vitest";
import { keyCommand, type KeyLike } from "./keys";

const key = (k: string, mods: Partial<Omit<KeyLike, "key">> = {}): KeyLike => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

describe("keyCommand", () => {
  it("maps Escape on every platform", () => {
    expect(keyCommand(key("Escape"), "macos")).toBe("escape");
    expect(keyCommand(key("Escape"), "windows")).toBe("escape");
  });

  it("uses Cmd on macOS and Ctrl on Windows for undo and redo", () => {
    expect(keyCommand(key("z", { metaKey: true }), "macos")).toBe("undo");
    expect(keyCommand(key("Z", { metaKey: true, shiftKey: true }), "macos")).toBe("redo");
    expect(keyCommand(key("z", { ctrlKey: true }), "macos")).toBeNull();
    expect(keyCommand(key("z", { ctrlKey: true }), "windows")).toBe("undo");
    expect(keyCommand(key("Z", { ctrlKey: true, shiftKey: true }), "windows")).toBe("redo");
    expect(keyCommand(key("y", { ctrlKey: true }), "windows")).toBe("redo");
    expect(keyCommand(key("y", { metaKey: true }), "macos")).toBeNull();
  });

  it("deletes with Delete or Backspace, without modifiers", () => {
    expect(keyCommand(key("Backspace"), "macos")).toBe("delete");
    expect(keyCommand(key("Delete"), "windows")).toBe("delete");
    expect(keyCommand(key("Backspace", { metaKey: true }), "macos")).toBeNull();
  });

  it("copies with Cmd/Ctrl+C or Enter and saves with Cmd/Ctrl+S", () => {
    expect(keyCommand(key("c", { metaKey: true }), "macos")).toBe("copy");
    expect(keyCommand(key("s", { metaKey: true }), "macos")).toBe("save");
    expect(keyCommand(key("Enter"), "macos")).toBe("copy");
    expect(keyCommand(key("c", { ctrlKey: true }), "windows")).toBe("copy");
    expect(keyCommand(key("S", { ctrlKey: true }), "windows")).toBe("save");
    expect(keyCommand(key("Enter"), "windows")).toBe("copy");
    // The other platform's modifier, extra modifiers and modified Enter do nothing.
    expect(keyCommand(key("c", { ctrlKey: true }), "macos")).toBeNull();
    expect(keyCommand(key("s", { metaKey: true }), "windows")).toBeNull();
    expect(keyCommand(key("s", { metaKey: true, shiftKey: true }), "macos")).toBeNull();
    expect(keyCommand(key("c", { metaKey: true, altKey: true }), "macos")).toBeNull();
    expect(keyCommand(key("Enter", { shiftKey: true }), "macos")).toBeNull();
    expect(keyCommand(key("Enter", { metaKey: true }), "macos")).toBeNull();
  });

  it("does not repeat an export while the key is held", () => {
    expect(keyCommand(key("Enter", { repeat: true }), "macos")).toBeNull();
    expect(keyCommand(key("c", { metaKey: true, repeat: true }), "macos")).toBeNull();
    expect(keyCommand(key("s", { ctrlKey: true, repeat: true }), "windows")).toBeNull();
    // Undo may repeat, as in other editors.
    expect(keyCommand(key("z", { metaKey: true, repeat: true }), "macos")).toBe("undo");
  });

  it("leaves the text editor its own keys, except save", () => {
    const inText = (k: KeyLike, platform: "macos" | "windows" = "macos") =>
      keyCommand(k, platform, true);
    // Copying selected text, a new line, its own undo and typing stay native.
    expect(inText(key("c", { metaKey: true }))).toBeNull();
    expect(inText(key("c", { ctrlKey: true }), "windows")).toBeNull();
    expect(inText(key("Enter"))).toBeNull();
    expect(inText(key("z", { metaKey: true }))).toBeNull();
    expect(inText(key("Backspace"))).toBeNull();
    // The textarea handles Escape itself (first Escape finishes the edit).
    expect(inText(key("Escape"))).toBeNull();
    // Save commits the text first instead of losing it.
    expect(inText(key("s", { metaKey: true }))).toBe("save");
    expect(inText(key("s", { ctrlKey: true }), "windows")).toBe("save");
  });

  it("leaves IME composition alone", () => {
    expect(keyCommand(key("Enter", { isComposing: true }), "macos")).toBeNull();
    expect(keyCommand(key("s", { metaKey: true, isComposing: true }), "macos", true)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(keyCommand(key("a"), "macos")).toBeNull();
    expect(keyCommand(key("z", { metaKey: true, altKey: true }), "macos")).toBeNull();
  });
});
