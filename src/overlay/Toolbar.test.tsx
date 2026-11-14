// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Toolbar } from "./Toolbar";
import { INITIAL_EDITOR } from "./editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    expect(timer?.title).toContain("clears annotations");
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
