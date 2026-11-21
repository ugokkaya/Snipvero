// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Toolbar } from "./Toolbar";
import { INITIAL_EDITOR } from "./editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("shows custom tooltips for every tool, including disabled actions, without changing clicks", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const send = vi.fn();
  const onExport = vi.fn();
  act(() =>
    root.render(
      <Toolbar
        position={{ x: 0, y: 0 }}
        tool="select"
        style={INITIAL_EDITOR.annotate.style}
        controls={{ color: true, size: true }}
        canUndo={false}
        canRedo={false}
        canDelete={false}
        canExport={true}
        keys={{ undo: "⌘Z", redo: "⇧⌘Z", copy: "⌘C", save: "⌘S" }}
        send={send}
        onExport={onExport}
        onCaptureDelayed={vi.fn()}
      />,
    ),
  );
  try {
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    for (const button of container.querySelectorAll("button")) {
      const anchor = button.parentElement;
      if (!anchor) throw new Error("Missing tooltip anchor");
      act(() => anchor.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
      const tooltip = container.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).toBe(button.getAttribute("aria-label"));
      expect(button.getAttribute("aria-describedby")).toBe(tooltip?.id);
      expect(button.hasAttribute("title")).toBe(false);
      act(() => anchor.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })));
      expect(container.querySelector('[role="tooltip"]')).toBeNull();
    }
    const text = container.querySelector<HTMLButtonElement>('button[aria-label="Text"]');
    act(() => text?.focus());
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Text");
    act(() => text?.blur());
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    act(() => text?.click());
    expect(send).toHaveBeenCalledWith({ type: "setTool", tool: "text" });
    const copy = container.querySelector<HTMLButtonElement>('button[aria-label^="Copy"]');
    act(() =>
      copy?.parentElement?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })),
    );
    expect(container.querySelector('[role="tooltip"]')?.textContent).toBe("Copy to clipboard (⌘C)");
    act(() => copy?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    expect(container.querySelector('[role="tooltip"]')).toBeNull();
    act(() => copy?.click());
    expect(onExport).toHaveBeenCalledWith("copy");
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it("offers a five-second recapture, warns about annotations and disables it during export", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onCaptureDelayed = vi.fn();
  const render = (canExport: boolean) =>
    act(() =>
      root.render(
        <Toolbar
          position={{ x: 0, y: 0 }}
          tool="select"
          style={INITIAL_EDITOR.annotate.style}
          controls={{ color: true, size: true }}
          canUndo={false}
          canRedo={false}
          canDelete={false}
          canExport={canExport}
          keys={{ undo: "", redo: "", copy: "", save: "" }}
          send={vi.fn()}
          onExport={vi.fn()}
          onCaptureDelayed={onCaptureDelayed}
        />,
      ),
    );
  try {
    render(true);
    const timer = container.querySelector<HTMLButtonElement>('button[aria-label*="5 seconds"]');
    expect(timer?.getAttribute("aria-label")).toContain("clears annotations");
    act(() => timer?.click());
    expect(onCaptureDelayed).toHaveBeenCalledOnce();
    render(false);
    expect(timer?.disabled).toBe(true);
    act(() => timer?.click());
    expect(onCaptureDelayed).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
  }
});

it("offers fill, blur and highlight, and dims the style buttons they do not use", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const send = vi.fn();
  const render = (controls: { color: boolean; size: boolean }) =>
    act(() =>
      root.render(
        <Toolbar
          position={{ x: 0, y: 0 }}
          tool="blur"
          style={INITIAL_EDITOR.annotate.style}
          controls={controls}
          canUndo={false}
          canRedo={false}
          canDelete={false}
          canExport={true}
          keys={{ undo: "", redo: "", copy: "", save: "" }}
          send={send}
          onExport={vi.fn()}
          onCaptureDelayed={vi.fn()}
        />,
      ),
    );
  const swatches = () => [
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label^="Color"]'),
  ];
  const sizes = () => [...container.querySelectorAll<HTMLButtonElement>('[aria-label*="stroke"]')];
  try {
    render({ color: false, size: false });
    for (const label of ["Fill", "Blur", "Highlight"]) {
      expect(container.querySelector(`button[aria-label^="${label}"]`)).not.toBeNull();
    }
    expect(
      container.querySelector('button[aria-label^="Blur"]')?.getAttribute("aria-pressed"),
    ).toBe("true");
    expect(swatches().length).toBeGreaterThan(0);
    expect(swatches().every((b) => b.disabled)).toBe(true);
    expect(sizes().every((b) => b.disabled)).toBe(true);
    // No button is ever removed, so the toolbar keeps the width the overlay places it with.
    const count = container.querySelectorAll("button").length;
    render({ color: true, size: false });
    expect(swatches().every((b) => !b.disabled)).toBe(true);
    expect(sizes().every((b) => b.disabled)).toBe(true);
    expect(container.querySelectorAll("button").length).toBe(count);
    const highlight = container.querySelector<HTMLButtonElement>('button[aria-label="Highlight"]');
    act(() => highlight?.click());
    expect(send).toHaveBeenCalledWith({ type: "setTool", tool: "highlight" });
  } finally {
    act(() => root.unmount());
  }
});
