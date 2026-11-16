import { describe, expect, it } from "vitest";
import type { AudioStatus } from "../ipc";
import { microphoneView, soundLabel } from "./audio";

const status = (overrides: Partial<AudioStatus> = {}): AudioStatus => ({
  supported: true,
  system: false,
  microphone: false,
  microphoneAccess: "notDetermined",
  ...overrides,
});

describe("microphoneView", () => {
  it("is off and quiet by default, and can be switched on to ask", () => {
    expect(microphoneView(status())).toEqual({ on: false, available: true, guidance: null });
  });

  it("is on only when chosen and allowed", () => {
    expect(microphoneView(status({ microphone: true, microphoneAccess: "authorized" })).on).toBe(
      true,
    );
    expect(microphoneView(status({ microphone: false, microphoneAccess: "authorized" })).on).toBe(
      false,
    );
  });

  it("shows a chosen microphone as off once the permission was turned off, with guidance", () => {
    const view = microphoneView(status({ microphone: true, microphoneAccess: "denied" }));
    expect(view).toEqual({ on: false, available: true, guidance: "denied" });
  });

  it("shows a chosen microphone as off when it was never asked (permission reset)", () => {
    const view = microphoneView(status({ microphone: true, microphoneAccess: "notDetermined" }));
    expect(view).toEqual({ on: false, available: true, guidance: null });
  });

  it("cannot be switched on when restricted, and says so", () => {
    expect(microphoneView(status({ microphoneAccess: "restricted" }))).toEqual({
      on: false,
      available: false,
      guidance: "restricted",
    });
  });

  it("is unavailable where sound cannot be recorded", () => {
    const view = microphoneView(status({ supported: false, microphoneAccess: "unsupported" }));
    expect(view).toEqual({ on: false, available: false, guidance: null });
  });
});

describe("soundLabel", () => {
  it("names each combination", () => {
    expect(soundLabel(false, false)).toBe("None");
    expect(soundLabel(true, false)).toBe("System audio");
    expect(soundLabel(false, true)).toBe("Microphone");
    expect(soundLabel(true, true)).toBe("System audio and microphone");
  });
});
