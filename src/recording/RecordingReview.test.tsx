// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingStatus } from "../ipc";

const ipc = vi.hoisted(() => ({
  onRecordingState: vi.fn(),
  recordingStatus: vi.fn(),
  recordingSave: vi.fn(),
  recordingCopy: vi.fn(),
  recordingDiscard: vi.fn(),
  recordingSource: vi.fn((id: number) => `snipvero-recording://localhost/${id}`),
  recordingGifPlan: vi.fn(),
  recordingExportGif: vi.fn(),
  recordingCancelGifExport: vi.fn(),
  onRecordingExportProgress: vi.fn(),
}));
vi.mock("../ipc", () => ipc);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const finished = (overrides: Partial<RecordingStatus> = {}): RecordingStatus => ({
  supported: true,
  phase: "finished",
  id: 7,
  elapsedMs: 0,
  capMs: 300_000,
  width: 640,
  height: 480,
  bytes: 1_234_567,
  durationMs: 12_000,
  notice: null,
  systemAudio: false,
  microphone: false,
  gifMaxWidth: 640,
  gifDefaultWidth: 640,
  gifDefaultFps: 10,
  ...overrides,
});

let root: Root;
let container: HTMLElement;
let pushState: ((status: RecordingStatus) => void) | undefined;

async function render(initial: RecordingStatus) {
  ipc.recordingStatus.mockResolvedValue(initial);
  const { RecordingReview } = await import("./RecordingReview");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<RecordingReview />));
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

beforeEach(() => {
  vi.clearAllMocks();
  ipc.onRecordingState.mockImplementation((handler: (status: RecordingStatus) => void) => {
    pushState = handler;
    return Promise.resolve(() => {});
  });
  ipc.recordingSave.mockResolvedValue("done");
  ipc.recordingCopy.mockResolvedValue(undefined);
  ipc.recordingDiscard.mockResolvedValue(undefined);
  ipc.onRecordingExportProgress.mockResolvedValue(() => {});
  ipc.recordingGifPlan.mockResolvedValue({
    width: 640,
    height: 480,
    fps: 10,
    ticks: 120,
    estimatedBytes: 4_000_000,
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("recording review", () => {
  it("plays the recording by its id and shows what it is", async () => {
    await render(finished());
    expect(container.querySelector("video")?.getAttribute("src")).toBe(
      "snipvero-recording://localhost/7",
    );
    const text = container.textContent ?? "";
    expect(text).toContain("640 × 480 px");
    expect(text).toContain("0:12");
    expect(text).toContain("1.2 MB");
  });

  it("saves with a suggested mp4 name and keeps the window for a cancelled dialog", async () => {
    ipc.recordingSave.mockResolvedValue("cancelled");
    await render(finished());
    await click(button("Save"));
    expect(ipc.recordingSave).toHaveBeenCalledTimes(1);
    const [id, name] = ipc.recordingSave.mock.calls[0] as [number, string];
    expect(id).toBe(7);
    expect(name).toMatch(/^Snipvero-\d{4}-\d{2}-\d{2}-\d{6}\.mp4$/);
    expect(button("Save").disabled).toBe(false);
  });

  it("copies the file or its path and says so", async () => {
    await render(finished());
    await click(button("Copy File"));
    expect(ipc.recordingCopy).toHaveBeenLastCalledWith(7, "file");
    expect(container.textContent).toContain("File copied.");
    await click(button("Copy Path"));
    expect(ipc.recordingCopy).toHaveBeenLastCalledWith(7, "path");
    expect(container.textContent).toContain("Path copied.");
  });

  it("discards by id", async () => {
    await render(finished());
    await click(button("Discard"));
    expect(ipc.recordingDiscard).toHaveBeenCalledWith(7);
  });

  it("shows a failed action and lets the user try again", async () => {
    ipc.recordingSave.mockRejectedValue("Could not save: disk full");
    await render(finished());
    await click(button("Save"));
    expect(container.querySelector(".banner")?.textContent).toBe("Could not save: disk full");
    expect(button("Save").disabled).toBe(false);
  });

  it("opens the GIF export panel from the button", async () => {
    await render(finished());
    expect(container.querySelector(".review-gif")).toBeNull();
    await click(button("Export as GIF"));
    expect(container.querySelector(".review-gif")).not.toBeNull();
    expect(button("Export as GIF").disabled).toBe(true);
  });

  it("says which sound the recording has, and plays it unmuted", async () => {
    await render(finished({ systemAudio: true, microphone: true }));
    expect(container.textContent).toContain("System audio and microphone");
    expect(container.querySelector("video")?.muted).toBe(false);
    document.body.innerHTML = "";
    await render(finished());
    expect(container.textContent).toContain("None");
  });

  it("explains why the recording ended early", async () => {
    await render(finished({ notice: "The recording stopped at the maximum length (5:00)." }));
    expect(container.querySelector(".review-notice")?.textContent).toContain("maximum length");
  });

  it("falls back to the details when the preview cannot play", async () => {
    await render(finished());
    await act(async () => {
      container.querySelector("video")?.dispatchEvent(new Event("error"));
    });
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain("could not be played");
    expect(button("Save").disabled).toBe(false);
  });

  it("follows the state: nothing to review once the recording is gone", async () => {
    await render(finished());
    await act(async () => pushState?.(finished({ phase: "idle", id: null })));
    expect(container.querySelector("video")).toBeNull();
    expect(container.textContent).toContain("no recording to review");
  });

  it("tells the user a recording in progress is stopped from the menu bar", async () => {
    await render(finished({ phase: "recording", id: 8 }));
    expect(container.textContent).toContain("Stop it from the menu bar");
  });
});
