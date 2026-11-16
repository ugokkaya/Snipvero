import type { AudioStatus } from "../ipc";

/** What the main window shows for the microphone, from the stored choice and the permission. */
export interface MicrophoneView {
  /** Whether the toggle is on: chosen and allowed. */
  on: boolean;
  /** Whether it can be switched on at all. */
  available: boolean;
  /** Guidance under the toggle, or null when there is nothing to say. */
  guidance: "denied" | "restricted" | null;
}

/**
 * The microphone is recorded only while the system allows it, so a stored "on" with a permission
 * that was turned off since shows as off, with the way to fix it. A permission that was never asked
 * shows as off and quiet: switching the toggle on is what asks.
 */
export function microphoneView(audio: AudioStatus): MicrophoneView {
  const allowed = audio.microphoneAccess === "authorized";
  const unsupported = !audio.supported || audio.microphoneAccess === "unsupported";
  return {
    on: audio.microphone && allowed,
    available: !unsupported && audio.microphoneAccess !== "restricted",
    guidance:
      audio.microphoneAccess === "denied" || audio.microphoneAccess === "restricted"
        ? audio.microphoneAccess
        : null,
  };
}

/** The review window's one-line description of a recording's sound. */
export function soundLabel(systemAudio: boolean, microphone: boolean): string {
  if (systemAudio && microphone) return "System audio and microphone";
  if (systemAudio) return "System audio";
  if (microphone) return "Microphone";
  return "None";
}
