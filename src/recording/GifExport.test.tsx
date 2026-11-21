// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GifExportProgress, RecordingStatus } from "../ipc";

const ipc = vi.hoisted(() => ({
  recordingGifPlan: vi.fn(),
  recordingExportGif: vi.fn(),
  recordingCancelGifExport: vi.fn(),
  onRecordingExportProgress: vi.fn(),
}));
vi.mock("../ipc", () => ipc);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const status: RecordingStatus = {
  supported: true,
  phase: "finished",
  id: 7,
  elapsedMs: 0,
  capMs: 300_000,
  width: 1200,
  height: 800,
  bytes: 1_000_000,
  durationMs: 12_000,
  notice: null,
  systemAudio: false,
  microphone: false,
  gifMaxWidth: 800,
  gifDefaultWidth: 600,
  gifDefaultFps: 10,
};

const plan = { width: 600, height: 400, fps: 10, ticks: 120, estimatedBytes: 4_200_000 };

let root: Root;
let container: HTMLElement;
let progress: ((p: GifExportProgress) => void) | undefined;
const onBusy = vi.fn();
const onClose = vi.fn();

async function render() {
  const { GifExport } = await import("./GifExport");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(<GifExport id={7} status={status} onBusy={onBusy} onClose={onClose} />),
  );
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes(label),
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

const select = (label: string) => {
  const found = [...container.querySelectorAll("label")].find((l) =>
    l.textContent?.includes(label),
  );
  const element = found?.querySelector("select");
  if (!element) throw new Error(`no select "${label}"`);
  return element;
};

const choose = (element: HTMLSelectElement, value: string) =>
  act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });

beforeEach(() => {
  vi.clearAllMocks();
  progress = undefined;
  ipc.recordingGifPlan.mockResolvedValue(plan);
  ipc.recordingCancelGifExport.mockResolvedValue(undefined);
  ipc.onRecordingExportProgress.mockImplementation((handler: (p: GifExportProgress) => void) => {
    progress = handler;
    return Promise.resolve(() => {});
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("gif export panel", () => {
  it("starts at the recording's default rate and width and shows the size estimate", async () => {
    await render();
    expect(select("Frame rate").value).toBe("10");
    expect(select("Width").value).toBe("600");
    expect(ipc.recordingGifPlan).toHaveBeenLastCalledWith(7, { fps: 10, width: 600 });
    const text = container.textContent ?? "";
    expect(text).toContain("600 × 400 px");
    expect(text).toContain("up to about 4.2 MB");
  });

  it("never offers more than 15 fps or the recording's maximum width", async () => {
    await render();
    const rates = [...select("Frame rate").options].map((o) => Number(o.value));
    const widths = [...select("Width").options].map((o) => Number(o.value));
    expect(Math.max(...rates)).toBeLessThanOrEqual(15);
    expect(Math.max(...widths)).toBeLessThanOrEqual(800);
    expect(widths).toContain(600);
  });

  it("asks again when a choice changes", async () => {
    await render();
    await choose(select("Frame rate"), "15");
    expect(ipc.recordingGifPlan).toHaveBeenLastCalledWith(7, { fps: 15, width: 600 });
    await choose(select("Width"), "320");
    expect(ipc.recordingGifPlan).toHaveBeenLastCalledWith(7, { fps: 15, width: 320 });
  });

  it("explains a recording that is too long and offers no export", async () => {
    ipc.recordingGifPlan.mockRejectedValue(
      "This recording is 1:20 long. A GIF can be made from at most 60 seconds of video; save it as an MP4 instead.",
    );
    await render();
    expect(container.querySelector(".banner")?.textContent).toContain("at most 60 seconds");
    expect(button("Export…").disabled).toBe(true);
  });

  it("exports with the chosen options and a .gif name, and reports the result", async () => {
    ipc.recordingExportGif.mockResolvedValue({ outcome: "done", bytes: 2_500_000, frames: 24 });
    await render();
    await choose(select("Frame rate"), "5");
    await click(button("Export…"));
    const [id, name, options] = ipc.recordingExportGif.mock.calls[0] as [number, string, unknown];
    expect(id).toBe(7);
    expect(name).toMatch(/^Snipvero-\d{4}-\d{2}-\d{2}-\d{6}\.gif$/);
    expect(options).toEqual({ fps: 5, width: 600 });
    expect(container.textContent).toContain("GIF saved (2.5 MB, 24 frames).");
    expect(onBusy).toHaveBeenNthCalledWith(1, true);
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  it("shows progress and lets the user cancel", async () => {
    let finish: (value: unknown) => void = () => {};
    ipc.recordingExportGif.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await render();
    await click(button("Export…"));
    expect(container.textContent).toContain("Choose where to save");
    expect(button("Close").disabled).toBe(true);
    await act(async () => progress?.({ id: 7, phase: "running", fraction: 0.42, message: null }));
    expect(container.textContent).toContain("42 %");
    expect(container.querySelector("progress")?.getAttribute("value")).toBe("42");
    // Progress of another recording is ignored.
    await act(async () => progress?.({ id: 8, phase: "running", fraction: 0.9, message: null }));
    expect(container.textContent).toContain("42 %");
    await click(button("Cancel export"));
    expect(ipc.recordingCancelGifExport).toHaveBeenCalledWith(7);
    expect(container.textContent).toContain("Cancelling");
    await act(async () => finish({ outcome: "cancelled", bytes: 0, frames: 0 }));
    expect(container.textContent).toContain("GIF export cancelled.");
    expect(button("Export…").disabled).toBe(false);
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  it("says nothing when the save dialog is dismissed", async () => {
    ipc.recordingExportGif.mockResolvedValue({ outcome: "cancelled", bytes: 0, frames: 0 });
    await render();
    await click(button("Export…"));
    expect(container.querySelector(".review-note")?.textContent).not.toContain("cancelled");
    expect(container.querySelector("progress")).toBeNull();
    expect(button("Export…").disabled).toBe(false);
  });

  it("shows a failed export and lets the user try again", async () => {
    ipc.recordingExportGif.mockRejectedValue("Could not export /tmp/a.gif: disk full");
    await render();
    await click(button("Export…"));
    expect(container.querySelector(".banner")?.textContent).toBe(
      "Could not export /tmp/a.gif: disk full",
    );
    expect(button("Export…").disabled).toBe(false);
    expect(onBusy).toHaveBeenLastCalledWith(false);
  });

  it("closes", async () => {
    await render();
    await click(button("Close"));
    expect(onClose).toHaveBeenCalled();
  });
});
