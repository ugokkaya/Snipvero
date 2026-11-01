import { describe, expect, it } from "vitest";
import { SHORTCUT_REJECTIONS } from "./ipc";
import { DEFAULT_ACCELERATOR, acceleratorFromKey, isCancel, rejectionMessage } from "./shortcut";

const press = (
  code: string,
  mods: Partial<Record<"meta" | "ctrl" | "alt" | "shift", boolean>> = {},
) => ({
  code,
  metaKey: mods.meta ?? false,
  ctrlKey: mods.ctrl ?? false,
  altKey: mods.alt ?? false,
  shiftKey: mods.shift ?? false,
});

describe("acceleratorFromKey", () => {
  it("records the default the way Rust registers it", () => {
    expect(acceleratorFromKey(press("Digit2", { meta: true, shift: true }), "macos")).toBe(
      DEFAULT_ACCELERATOR,
    );
    expect(acceleratorFromKey(press("Digit2", { ctrl: true, shift: true }), "windows")).toBe(
      DEFAULT_ACCELERATOR,
    );
  });

  it("uses the physical key, whatever the layout types", () => {
    // Turkish Q: Shift+2 types ', Option+S types ß; the key code stays the same.
    expect(acceleratorFromKey(press("KeyS", { meta: true, alt: true }), "macos")).toBe(
      "CommandOrControl+Alt+S",
    );
    expect(acceleratorFromKey(press("ArrowUp", { ctrl: true, alt: true }), "windows")).toBe(
      "CommandOrControl+Alt+ArrowUp",
    );
  });

  it("keeps Control and the Windows key distinct from the primary modifier", () => {
    expect(acceleratorFromKey(press("KeyA", { ctrl: true, shift: true }), "macos")).toBe(
      "Control+Shift+A",
    );
    expect(acceleratorFromKey(press("F5", { meta: true }), "windows")).toBe("Super+F5");
  });

  it("waits while only modifiers are held", () => {
    for (const code of ["MetaLeft", "ShiftRight", "ControlLeft", "AltRight", "CapsLock", "Fn"]) {
      expect(acceleratorFromKey(press(code, { meta: true }), "macos")).toBeNull();
    }
    expect(acceleratorFromKey({ ...press("KeyA"), isComposing: true }, "macos")).toBeNull();
  });

  it("passes other keys on for Rust to judge", () => {
    expect(acceleratorFromKey(press("KeyC", { meta: true }), "macos")).toBe("CommandOrControl+C");
  });
});

describe("isCancel", () => {
  it("is Escape alone", () => {
    expect(isCancel(press("Escape"))).toBe(true);
    expect(isCancel(press("Escape", { meta: true, alt: true }))).toBe(false);
    expect(isCancel(press("KeyQ"))).toBe(false);
  });
});

describe("rejectionMessage", () => {
  it("words every rejection Rust can send, per platform", () => {
    for (const rejection of SHORTCUT_REJECTIONS) {
      expect(rejectionMessage(rejection, "macos")).not.toBe("");
    }
    expect(rejectionMessage("modifiers", "macos")).toContain("⌘⇧");
    expect(rejectionMessage("modifiers", "windows")).toContain("Ctrl+Shift");
  });
});
