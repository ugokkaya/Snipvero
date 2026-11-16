// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioStatus } from "../ipc";

const ipc = vi.hoisted(() => ({
  recordingAudio: vi.fn(),
  recordingSetAudio: vi.fn(),
  openMicrophoneSettings: vi.fn(),
}));
vi.mock("../ipc", () => ipc);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { RecordingAudio } from "./RecordingAudio";

const audio = (overrides: Partial<AudioStatus> = {}): AudioStatus => ({
  supported: true,
  system: false,
  microphone: false,
  microphoneAccess: "notDetermined",
  ...overrides,
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  ipc.recordingAudio.mockResolvedValue(audio());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<RecordingAudio />));
}

const box = (label: string): HTMLInputElement => {
  const found = [...container.querySelectorAll("label")].find((l) =>
    l.textContent?.includes(label),
  );
  const input = found?.querySelector("input");
  if (!input) throw new Error(`no switch "${label}"`);
  return input;
};

const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });

describe("recording sound switches", () => {
  it("starts with both off and asks for no permission", async () => {
    await render();
    expect(box("System audio").checked).toBe(false);
    expect(box("Microphone").checked).toBe(false);
    expect(ipc.recordingSetAudio).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("System Settings");
  });

  it("shows nothing where sound cannot be recorded", async () => {
    ipc.recordingAudio.mockResolvedValue(audio({ supported: false }));
    await render();
    expect(container.textContent).toBe("");
  });

  it("switches system audio on and shows what Rust stored", async () => {
    ipc.recordingSetAudio.mockResolvedValue(audio({ system: true }));
    await render();
    await click(box("System audio"));
    expect(ipc.recordingSetAudio).toHaveBeenCalledWith("system", true);
    expect(box("System audio").checked).toBe(true);
  });

  it("switches the microphone on once the system allows it", async () => {
    ipc.recordingSetAudio.mockResolvedValue(
      audio({ microphone: true, microphoneAccess: "authorized" }),
    );
    await render();
    await click(box("Microphone"));
    expect(ipc.recordingSetAudio).toHaveBeenCalledWith("microphone", true);
    expect(box("Microphone").checked).toBe(true);
    expect(container.textContent).not.toContain("Open System Settings");
  });

  it("leaves a refused microphone off and says how to allow it", async () => {
    ipc.recordingSetAudio.mockResolvedValue(audio({ microphoneAccess: "denied" }));
    await render();
    await click(box("Microphone"));
    expect(box("Microphone").checked).toBe(false);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Privacy & Security");
    const open = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Open System Settings"),
    );
    if (!open) throw new Error("no System Settings button");
    await click(open);
    expect(ipc.openMicrophoneSettings).toHaveBeenCalledTimes(1);
  });

  it("shows a microphone whose permission was turned off since as off, with guidance", async () => {
    ipc.recordingAudio.mockResolvedValue(audio({ microphone: true, microphoneAccess: "denied" }));
    await render();
    expect(box("Microphone").checked).toBe(false);
    expect(container.textContent).toContain("Microphone access is off");
  });

  it("cannot switch a restricted microphone on", async () => {
    ipc.recordingAudio.mockResolvedValue(
      audio({ microphone: true, microphoneAccess: "restricted" }),
    );
    await render();
    expect(box("Microphone").disabled).toBe(true);
    expect(container.textContent).toContain("restricted");
  });

  it("shows an error from Rust instead of changing nothing silently", async () => {
    ipc.recordingSetAudio.mockRejectedValue("the settings could not be written");
    await render();
    await click(box("System audio"));
    expect(container.textContent).toContain("the settings could not be written");
  });
});
